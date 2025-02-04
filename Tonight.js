import Fastify from "fastify"
import WebSocket from "ws"
import dotenv from "dotenv"
import fastifyFormBody from "@fastify/formbody"
import fastifyWs from "@fastify/websocket"
import twilio from "twilio"
import OpenAI from "openai"
import {
  initializeDatabase,
  importCSV,
  addLead,
  getLead,
  updateLeadStatus,
  addConversation,
  getConversationHistory,
  getAllPhoneNumbers,
  getLeadData,
  getPaginatedLeadData,
  standardizePhoneNumber,
  updateLeadEmail,
  testDatabaseWrite,
} from "./database.js"

// Load environment variables from .env file
dotenv.config()

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PHONE_NUMBER_FROM,
  DOMAIN: rawDomain,
  OPENAI_API_KEY,
  PORT,
  CSV_FILE_PATH,
  TWILIO_DEV_PHONE,
  DATABASE_PATH,
} = process.env

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.")
  process.exit(1)
}

// Constants
const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, "").replace(/\/+$/, "")
const SERVER_PORT = Number.parseInt(PORT) || 80
const SYSTEM_MESSAGE = `You are an AI assistant making a phone call. Your goal is to have a brief, friendly conversation and collect the customer's email address. Follow these guidelines:
1. Introduce yourself briefly and ask how you can help.
2. During the conversation, ask for the customer's email address.
3. After receiving the email, confirm it by repeating it back to the customer.
4. Once confirmed, say "Thank you, I've recorded your email as [email address]."
5. Keep responses short and to the point.
6. End the call politely after collecting the email or if the customer indicates they're done.`
const VOICE = "alloy"

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
})

// Initialize the Twilio library
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

// Initialize Fastify
const fastify = Fastify()
fastify.register(fastifyFormBody)
fastify.register(fastifyWs)

// Function to make an outgoing call
async function makeOutgoingCall(to, from, url) {
  try {
    const standardizedNumber = standardizePhoneNumber(to)
    if (!standardizedNumber) {
      console.error("Invalid phone number:", to)
      return null
    }

    const lead = await getLead(standardizedNumber)
    if (!lead) {
      await addLead({
        phone_number: standardizedNumber,
        name: "Unknown",
        status: "new",
      })
    }

    const call = await client.calls.create({
      twiml: `<Response><Say>Hello, this is an automated call.</Say><Connect><Stream url="${url}"><Parameter name="customerNumber" value="${standardizedNumber}"/></Stream></Connect></Response>`,
      to: standardizedNumber,
      from: from,
    })
    console.log(`Call SID: ${call.sid} to ${standardizedNumber}`)
    await updateLeadStatus(standardizedNumber, "called")
    return call
  } catch (error) {
    console.error(`Error making call to ${to}:`, error)
    return null
  }
}

// New getCompletion function
async function getCompletion(text) {
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: text },
    ],
  })
  return completion.choices[0].message.content
}

// Function to validate email
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// Root Route
fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" })
})

// WebSocket route for media-stream
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected")

    let streamSid = null
    let customerNumber = null
    let latestMediaTimestamp = 0
    let lastAssistantItem = null
    const markQueue = []
    let responseStartTimestampTwilio = null
    let accumulatedText = ""
    const customerNumbers = new Map()
    let silenceTimeout = null

    const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    })

    // Control initial session with OpenAI
    const initializeSession = () => {
      const sessionUpdate = {
        type: "session.update",
        session: {
          turn_detection: { type: "server_vad" },
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          voice: VOICE,
          instructions: SYSTEM_MESSAGE,
          modalities: ["text", "audio"],
          temperature: 0.8,
        },
      }

      console.log("Sending session update:", JSON.stringify(sessionUpdate))
      openAiWs.send(JSON.stringify(sessionUpdate))
    }

    // Send mark messages to Media Streams
    const sendMark = (connection, streamSid) => {
      if (streamSid) {
        const markEvent = {
          event: "mark",
          streamSid: streamSid,
          mark: { name: "responsePart" },
        }
        connection.send(JSON.stringify(markEvent))
        markQueue.push("responsePart")
      }
    }

    // Add this function inside the WebSocket route
    const handleEndOfSpeech = () => {
      if (openAiWs.readyState === WebSocket.OPEN) {
        const endOfSpeech = {
          type: "input_audio_buffer.speech_stopped",
        }
        openAiWs.send(JSON.stringify(endOfSpeech))
      }
    }

    const promptAIIfSilent = (timeoutMs = 10000) => {
      if (silenceTimeout) clearTimeout(silenceTimeout)
      silenceTimeout = setTimeout(() => {
        if (openAiWs.readyState === WebSocket.OPEN) {
          const promptMessage = {
            type: "input_text.append",
            text: "There has been a pause in the conversation. Politely ask if there's anything else you can help with or if the customer has any questions.",
          }
          openAiWs.send(JSON.stringify(promptMessage))
        }
      }, timeoutMs)
    }

    // Open event for OpenAI WebSocket
    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API")
      setTimeout(initializeSession, 100)
    })

    // Listen for messages from the OpenAI WebSocket
    openAiWs.on("message", async (data) => {
      try {
        const response = JSON.parse(data)
        console.log("Received OpenAI event:", response.type)

        if (response.type === "response.text.delta" && response.delta) {
          accumulatedText += response.delta
          console.log("Accumulated text:", accumulatedText)
        }

        if (response.type === "response.content.done") {
          console.log("AI response complete. Accumulated text:", accumulatedText)
          const aiResponse = accumulatedText
          accumulatedText = "" // Reset accumulated text

          // Store AI response in the database
          if (customerNumber) {
            console.log(`AI response for ${customerNumber}: ${aiResponse.substring(0, 50)}...`)
            await addConversation(customerNumber, aiResponse, true)

            // Improved email extraction
            const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/i
            const emailMatch = aiResponse.match(emailRegex)
            if (emailMatch) {
              const email = emailMatch[0]
              console.log(`Extracted email: ${email}`)
              try {
                const updatedLead = await updateLeadEmail(customerNumber, email)
                if (updatedLead && updatedLead.email === email) {
                  console.log(`Successfully updated email for ${customerNumber}: ${email}`)
                } else {
                  console.error(`Failed to update email for ${customerNumber}: ${email}`)
                }
              } catch (error) {
                console.error(`Error updating email for ${customerNumber}:`, error)
              }
            } else {
              console.log("No email found in the AI response")
            }

            // Log the updated lead information
            const updatedLead = await getLead(customerNumber)
            console.log(`Updated lead information:`, updatedLead)
          }

          // Send AI response back to Twilio for text-to-speech
          const ttsEvent = {
            event: "tts",
            streamSid: streamSid,
            text: aiResponse,
          }
          connection.send(JSON.stringify(ttsEvent))
          console.log("Sent TTS event to Twilio:", ttsEvent)

          // Always prompt the AI to continue the conversation
          setTimeout(() => {
            const continueConversation = {
              type: "input_text.append",
              text: "Continue the conversation naturally. If there's been a pause, politely ask if there's anything else you can help with.",
            }
            openAiWs.send(JSON.stringify(continueConversation))
          }, 5000) // Wait 5 seconds before prompting to continue
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: Buffer.from(response.delta, "base64").toString("base64") },
          }
          connection.send(JSON.stringify(audioDelta))
          console.log("Sent audio delta to Twilio")

          if (!responseStartTimestampTwilio) {
            responseStartTimestampTwilio = latestMediaTimestamp
          }

          if (response.item_id) {
            lastAssistantItem = response.item_id
          }

          sendMark(connection, streamSid)
        }
      } catch (error) {
        console.error("Error processing OpenAI message:", error, "Raw message:", data)
      }
    })

    // Handle incoming messages from Twilio
    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message)
        console.log("Received Twilio event:", data.event, "StreamSID:", data.streamSid)

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid
            console.log("Start event data:", JSON.stringify(data.start))
            customerNumber = data.start.customParameters?.customerNumber || data.start.To || data.start.to
            console.log("Initial customerNumber:", customerNumber)

            if (customerNumber) {
              customerNumber = standardizePhoneNumber(customerNumber)
              console.log("Standardized customerNumber:", customerNumber)
              customerNumbers.set(streamSid, customerNumber)
              console.log(`Stored customerNumber ${customerNumber} for StreamSID: ${streamSid}`)

              // Initiate the conversation with a greeting
              const greeting = "Hello! How can I assist you today?"
              const ttsEvent = {
                event: "tts",
                streamSid: streamSid,
                text: greeting,
              }
              connection.send(JSON.stringify(ttsEvent))
              console.log("Sent initial greeting:", greeting)
            } else {
              console.error("Customer number not found in start event")
            }
            break
          case "media":
            if (!customerNumber) {
              customerNumber = customerNumbers.get(streamSid)
              console.log(`Retrieved customerNumber ${customerNumber} for StreamSid: ${streamSid} from storage`)
            }
            if (!customerNumber) {
              console.error("Received media event without customerNumber for StreamSID:", streamSid)
              return
            }
            latestMediaTimestamp = data.media.timestamp
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              }
              openAiWs.send(JSON.stringify(audioAppend))
            } else {
              console.error("OpenAI WebSocket is not open. Current state:", openAiWs.readyState)
            }
            // Store user's speech in the database
            await addConversation(customerNumber, "User audio received", false)
            if (!customerNumbers.has(data.streamSid)) {
              console.log(`Call in progress: ${customerNumber}`)
              customerNumbers.set(data.streamSid, customerNumber)
            }
            // Add this at the end of the 'media' case
            if (data.media && data.media.track === "inbound" && data.media.chunk === "end") {
              handleEndOfSpeech()
            }
            promptAIIfSilent()
            break
          case "mark":
            if (markQueue.length > 0) {
              markQueue.shift()
            }
            break
          case "stop":
            console.log(`Call ended for StreamSID: ${data.streamSid}`)
            customerNumbers.delete(data.streamSid)
            break
          default:
            console.log("Received non-media event:", data.event)
            break
        }
      } catch (error) {
        console.error("Error processing Twilio message:", error)
        console.error("Message that caused the error:", message)
      }
    })

    // Handle connection close
    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close()
      console.log("Client disconnected.")
    })

    // Handle WebSocket close and errors
    openAiWs.on("close", () => {
      console.log("Disconnected from the OpenAI Realtime API")
    })

    openAiWs.on("error", (error) => {
      console.error("Error in the OpenAI WebSocket:", error)
    })

    connection.on("error", (error) => {
      console.error("WebSocket connection error:", error)
    })
  })
})

// New route to get conversation history
fastify.get("/conversation-history/:phoneNumber", async (request, reply) => {
  const { phoneNumber } = request.params
  const history = await getConversationHistory(phoneNumber)
  reply.send(history)
})

// Add a new route to get lead data
fastify.get("/lead/:phoneNumber", async (request, reply) => {
  const { phoneNumber } = request.params
  const leadData = await getLeadData(phoneNumber)
  if (leadData) {
    reply.send(leadData)
  } else {
    reply.code(404).send({ error: "Lead not found" })
  }
})

// Add a new route to get paginated lead data
fastify.get("/leads", async (request, reply) => {
  const page = Number.parseInt(request.query.page) || 1
  const pageSize = Number.parseInt(request.query.pageSize) || 10
  const paginatedData = await getPaginatedLeadData(page, pageSize)
  reply.send(paginatedData)
})

// Function to initiate calls to all numbers in the database
async function initiateCallsToAllNumbers() {
  try {
    const phoneNumbers = await getAllPhoneNumbers()
    console.log(`Found ${phoneNumbers.length} valid phone numbers to call.`)

    const devPhoneNumber = "+16286666632"
    const standardizedDevPhone = standardizePhoneNumber(devPhoneNumber)

    if (standardizedDevPhone) {
      console.log(`Initiating call to dev phone: ${standardizedDevPhone}`)
      const call = await makeOutgoingCall(standardizedDevPhone, PHONE_NUMBER_FROM, `wss://${DOMAIN}/media-stream`)
      if (call) {
        console.log(`Successfully initiated call to dev phone: ${standardizedDevPhone}`)
      } else {
        console.log(`Failed to initiate call to dev phone: ${standardizedDevPhone}`)
      }
      console.log("Stopping after dev phone call as requested.")
      return // This will stop the function after calling the dev phone
    } else {
      console.warn("Dev phone number is invalid.")
    }

    // The following code will only run if the dev phone call fails
    for (const phoneNumber of phoneNumbers) {
      if (phoneNumber && phoneNumber !== standardizedDevPhone) {
        console.log(`Initiating call to ${phoneNumber}`)
        const call = await makeOutgoingCall(phoneNumber, PHONE_NUMBER_FROM, `wss://${DOMAIN}/media-stream`)
        if (call) {
          console.log(`Successfully initiated call to ${phoneNumber}`)
        } else {
          console.log(`Skipped call to ${phoneNumber} due to error`)
        }
        // Add a delay between calls to avoid overwhelming the system
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
    console.log("Finished initiating all calls")
  } catch (error) {
    console.error("Error initiating calls:", error)
  }
}

// New route to manually trigger calls
fastify.get("/start-calls", async (request, reply) => {
  console.log("Initiating calls to all numbers in the database")
  initiateCallsToAllNumbers()
    .then(() => reply.send({ message: "Calls initiated successfully" }))
    .catch((error) => reply.code(500).send({ error: "Failed to initiate calls" }))
})

// New route to manually import CSV
fastify.get("/import-csv", async (request, reply) => {
  if (CSV_FILE_PATH) {
    try {
      await importCSV(CSV_FILE_PATH)
      reply.send({ message: "CSV data imported successfully" })
    } catch (error) {
      console.error("Error importing CSV:", error)
      reply.code(500).send({ error: "Failed to import CSV data" })
    }
  } else {
    reply.code(400).send({ error: "CSV_FILE_PATH not set in environment variables" })
  }
})

// Add this new route for testing database writes
fastify.get("/test-db-write", async (request, reply) => {
  const result = await testDatabaseWrite()
  if (result) {
    reply.send({ message: "Database write test successful" })
  } else {
    reply.code(500).send({ error: "Database write test failed" })
  }
})

// Add this new route for testing database connection and write
fastify.get("/test-db", async (request, reply) => {
  try {
    console.log("Testing database connection and write operation")
    console.log(`Using database path: ${DATABASE_PATH}`)

    await initializeDatabase()
    const result = await testDatabaseWrite()

    if (result) {
      reply.send({
        message: "Database test successful",
        databasePath: DATABASE_PATH,
      })
    } else {
      reply.code(500).send({
        error: "Database test failed",
        databasePath: DATABASE_PATH,
      })
    }
  } catch (error) {
    console.error("Error during database test:", error)
    reply.code(500).send({
      error: "Database test failed with exception",
      message: error.message,
      databasePath: DATABASE_PATH,
    })
  }
})

// Add these imports at the top of the file if they're not already there
// import { addLead, getLead } from "./database.js" - Already imported

// Add this new route after the other routes
fastify.get("/test-lead", async (request, reply) => {
  try {
    const testPhoneNumber = "+11234567890"
    const testEmail = "test@example.com"

    // Add a test lead
    await addLead({
      phone_number: testPhoneNumber,
      email: testEmail,
      name: "Test User",
      status: "new",
    })

    // Retrieve the test lead
    const lead = await getLead(testPhoneNumber)

    if (lead && lead.email === testEmail) {
      reply.send({
        message: "Test lead successfully added and retrieved",
        lead,
      })
    } else {
      reply.code(500).send({
        error: "Test lead retrieval failed",
        lead,
      })
    }
  } catch (error) {
    console.error("Error during lead test:", error)
    reply.code(500).send({
      error: "Lead test failed with exception",
      message: error.message,
    })
  }
})

// Initialize server
fastify.listen({ port: SERVER_PORT, host: "0.0.0.0" }, async (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`Server is listening on port ${SERVER_PORT}`)

  try {
    // Initialize the database
    await initializeDatabase()
    console.log("Database initialized successfully")

    // Test database write
    const testResult = await testDatabaseWrite()
    if (testResult) {
      console.log("Database write test passed")
    } else {
      console.error("Database write test failed")
    }
  } catch (error) {
    console.error("Error during server initialization:", error)
  }

  console.log("Server is ready. You can now access the API endpoints.")
  console.log("To view leads, visit http://localhost:80/leads?page=1&pageSize=10")
  console.log("To import CSV data, visit http://localhost:80/import-csv")
  console.log("To start making calls, visit http://localhost:80/start-calls")
  console.log("To test database write, visit http://localhost:80/test-db-write")
  console.log("To test database connection and write, visit http://localhost:80/test-db")
  console.log("To test lead insertion and retrieval, visit http://localhost:80/test-lead")
})

