import Fastify from "fastify"
import WebSocket from "ws"
import dotenv from "dotenv"
import fastifyFormBody from "@fastify/formbody"
import fastifyWs from "@fastify/websocket"
import twilio from "twilio"
import OpenAI from "openai"
import {
  initializeDatabase,
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
  addTwilioDevPhone,
  importCSV,
  updateCallTranscript,
  processAIResponseAndUpdateLead,
} from "./database.js"
import path from "path"
import fs from "fs"
import ffmpeg from "fluent-ffmpeg"
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg"

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

ffmpeg.setFfmpegPath(ffmpegInstaller.path)

if (!OPENAI_API_KEY) {
  console.error("Missing OpenAI API key. Please set it in the .env file.")
  process.exit(1)
}

const DOMAIN = rawDomain.replace(/(^\w+:|^)\/\//, "").replace(/\/+$/, "")
const SERVER_PORT = Number.parseInt(PORT) || 80
const SYSTEM_MESSAGE = `You are an AI assistant making a phone call. Your primary goal is to have a friendly conversation and collect the customer's email address. Follow these guidelines:
1. Introduce yourself and ask how you can help.
2. During the conversation, politely ask for the customer's email address if they haven't provided it.
3. After receiving the email, confirm it by repeating it back to the customer and asking if it's correct.
4. Once you have confirmed the email, say "Thank you, I've recorded your email as [email address]."
5. Always keep the conversation going by asking relevant follow-up questions or offering additional assistance.
6. Never end the call abruptly. Wait for the customer to indicate they're done talking.
7. If there's a pause in the conversation, take the initiative to ask if there's anything else you can help with.
8. Be patient, friendly, and attentive throughout the entire call.`
const VOICE = "alloy"
const RECORDINGS_DIR = path.join(process.cwd(), "recordings")
console.log(`Recordings directory set to: ${RECORDINGS_DIR}`)

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
})

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)

const fastify = Fastify()
fastify.register(fastifyFormBody)
fastify.register(fastifyWs)

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

fastify.get("/", async (request, reply) => {
  reply.send({ message: "Twilio Media Stream Server is running!" })
})

async function ensureRecordingsDirExists() {
  try {
    await fs.promises.access(RECORDINGS_DIR)
    console.log(`Recordings directory already exists: ${RECORDINGS_DIR}`)
  } catch {
    await fs.promises.mkdir(RECORDINGS_DIR, { recursive: true })
    console.log(`Created recordings directory: ${RECORDINGS_DIR}`)
  }
}

async function saveRecording(streamSid, incomingAudioBuffer, outgoingAudioBuffer) {
  console.log(`Attempting to save recording for StreamSID: ${streamSid}`)
  console.log(`Incoming audio buffer length: ${incomingAudioBuffer.length}`)
  console.log(`Outgoing audio buffer length: ${outgoingAudioBuffer.length}`)
  await ensureRecordingsDirExists()
  const timestamp = new Date().toISOString().replace(/:/g, "-")
  const incomingFileName = `${streamSid}_incoming_${timestamp}.mp3`
  const outgoingFileName = `${streamSid}_outgoing_${timestamp}.mp3`
  const incomingFilePath = path.join(RECORDINGS_DIR, incomingFileName)
  const outgoingFilePath = path.join(RECORDINGS_DIR, outgoingFileName)

  // Save incoming audio
  await new Promise((resolve, reject) => {
    const tempIncomingFile = path.join(RECORDINGS_DIR, `${streamSid}_incoming_temp.raw`)
    fs.writeFileSync(tempIncomingFile, incomingAudioBuffer)

    ffmpeg()
      .input(tempIncomingFile)
      .inputFormat("mulaw")
      .inputOptions(["-ar 8000", "-ac 1"])
      .audioFrequency(8000)
      .audioChannels(1)
      .toFormat("mp3")
      .audioBitrate("64k")
      .on("error", (err) => {
        console.error("Error converting incoming audio to MP3:", err)
        fs.unlinkSync(tempIncomingFile)
        reject(err)
      })
      .on("end", () => {
        console.log(`Incoming audio saved as MP3 for StreamSID: ${streamSid}`)
        fs.unlinkSync(tempIncomingFile)
        resolve()
      })
      .save(incomingFilePath)
  })

  // Save outgoing audio
  await new Promise((resolve, reject) => {
    const tempOutgoingFile = path.join(RECORDINGS_DIR, `${streamSid}_outgoing_temp.raw`)
    fs.writeFileSync(tempOutgoingFile, outgoingAudioBuffer)

    ffmpeg()
      .input(tempOutgoingFile)
      .inputFormat("mulaw")
      .inputOptions(["-ar 8000", "-ac 1"])
      .audioFrequency(8000)
      .audioChannels(1)
      .toFormat("mp3")
      .audioBitrate("64k")
      .on("error", (err) => {
        console.error("Error converting outgoing audio to MP3:", err)
        fs.unlinkSync(tempOutgoingFile)
        reject(err)
      })
      .on("end", () => {
        console.log(`Outgoing audio saved as MP3 for StreamSID: ${streamSid}`)
        fs.unlinkSync(tempOutgoingFile)
        resolve()
      })
      .save(outgoingFilePath)
  })

  console.log(`Recordings saved for StreamSID: ${streamSid}`)
  return { incomingFilePath, outgoingFilePath }
}

async function transcribeAndSaveRecording(streamSid, customerNumber, outgoingFilePath) {
  try {
    // Transcribe outgoing audio (AI responses)
    const outgoingTranscription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(outgoingFilePath),
      model: "whisper-1",
      language: "en",
    })

    console.log(`Transcription completed for StreamSID: ${streamSid}`)

    // Save transcription to database
    await updateCallTranscript(streamSid, "outgoing", outgoingTranscription.text)

    // Process AI response transcript and update lead information
    await processAIResponseAndUpdateLead(streamSid, outgoingTranscription.text)

    // Add transcription to conversation history
    await addConversation(customerNumber, `Outgoing: ${outgoingTranscription.text}`, true)

    console.log(`Transcription saved to database and processed for StreamSID: ${streamSid}`)
  } catch (error) {
    console.error(`Error transcribing and saving recording for StreamSID: ${streamSid}:`, error)
  }
}

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
    let incomingAudioBuffer = Buffer.alloc(0)
    let outgoingAudioBuffer = Buffer.alloc(0)

    const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    })

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

    openAiWs.on("open", () => {
      console.log("Connected to the OpenAI Realtime API")
      setTimeout(initializeSession, 100)
    })

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
          accumulatedText = ""

          if (customerNumber) {
            console.log(`AI response for ${customerNumber}: ${aiResponse.substring(0, 50)}...`)
            await addConversation(customerNumber, aiResponse, true)

            const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/i
            const emailMatch = aiResponse.match(emailRegex)
            if (emailMatch) {
              const email = emailMatch[0]
              console.log(`Extracted email: ${email}`)
              try {
                await updateLeadEmail(customerNumber, email)
                console.log(`Updated email for ${customerNumber}: ${email}`)
              } catch (error) {
                console.error(`Error updating email for ${customerNumber}:`, error)
              }
            } else {
              console.log("No email found in the AI response")
            }

            const updatedLead = await getLead(customerNumber)
            console.log(`Updated lead information:`, updatedLead)
          }

          const ttsEvent = {
            event: "tts",
            streamSid: streamSid,
            text: aiResponse,
          }
          connection.send(JSON.stringify(ttsEvent))
          console.log("Sent TTS event to Twilio:", ttsEvent)

          setTimeout(() => {
            const continueConversation = {
              type: "input_text.append",
              text: "Continue the conversation naturally. If there's been a pause, politely ask if there's anything else you can help with.",
            }
            openAiWs.send(JSON.stringify(continueConversation))
          }, 5000)
        }

        if (response.type === "response.audio.delta" && response.delta) {
          const audioDelta = {
            event: "media",
            streamSid: streamSid,
            media: { payload: Buffer.from(response.delta, "base64").toString("base64") },
          }
          connection.send(JSON.stringify(audioDelta))
          console.log("Sent audio delta to Twilio")

          console.log(`Received AI audio data. Buffer length before: ${outgoingAudioBuffer.length}`)
          outgoingAudioBuffer = Buffer.concat([outgoingAudioBuffer, Buffer.from(response.delta, "base64")])
          console.log(`Buffer length after: ${outgoingAudioBuffer.length}`)

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

    connection.on("message", async (message) => {
      try {
        const data = JSON.parse(message)
        console.log("Received Twilio event:", data.event, "StreamSID:", data.streamSid)

        switch (data.event) {
          case "start":
            streamSid = data.start.streamSid
            customerNumber = data.start.customParameters?.customerNumber
            console.log("Incoming stream started", streamSid, "for customer", customerNumber)
            responseStartTimestampTwilio = null
            latestMediaTimestamp = 0
            incomingAudioBuffer = Buffer.alloc(0)
            outgoingAudioBuffer = Buffer.alloc(0)
            break
          case "media":
            latestMediaTimestamp = data.media.timestamp
            if (openAiWs.readyState === WebSocket.OPEN) {
              const audioAppend = {
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              }
              openAiWs.send(JSON.stringify(audioAppend))

              console.log(`Received audio data. Buffer length before: ${incomingAudioBuffer.length}`)
              incomingAudioBuffer = Buffer.concat([incomingAudioBuffer, Buffer.from(data.media.payload, "base64")])
              console.log(`Buffer length after: ${incomingAudioBuffer.length}`)
            }
            await addConversation(customerNumber, "User audio received", false)
            if (!customerNumbers.has(data.streamSid)) {
              console.log(`Call in progress: ${customerNumber}`)
              customerNumbers.set(data.streamSid, customerNumber)
            }
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
            console.log(`Call ended for customer`, customerNumber)
            customerNumbers.delete(data.streamSid)
            if (outgoingAudioBuffer.length > 0) {
              try {
                console.log(`Saving recording for StreamSID: ${streamSid}`)
                const { outgoingFilePath } = await saveRecording(
                  streamSid,
                  Buffer.alloc(0), // Empty buffer for incoming audio
                  outgoingAudioBuffer,
                )
                console.log(`Recording saved successfully for StreamSID: ${streamSid}`)

                // Transcribe and save the recording
                await transcribeAndSaveRecording(streamSid, customerNumber, outgoingFilePath)

                // Update lead status
                await updateLeadStatus(customerNumber, "call_completed")
              } catch (error) {
                console.error(`Error processing recording for StreamSID: ${streamSid}:`, error)
              }
              outgoingAudioBuffer = Buffer.alloc(0)
            } else {
              console.log(`No audio data to save for StreamSID: ${streamSid}`)
            }
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

    connection.on("close", () => {
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close()
      console.log("Client disconnected.")
    })

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

fastify.get("/conversation-history/:phoneNumber", async (request, reply) => {
  const { phoneNumber } = request.params
  const history = await getConversationHistory(phoneNumber)
  reply.send(history)
})

fastify.get("/lead/:phoneNumber", async (request, reply) => {
  const { phoneNumber } = request.params
  const leadData = await getLeadData(phoneNumber)
  if (leadData) {
    reply.send(leadData)
  } else {
    reply.code(404).send({ error: "Lead not found" })
  }
})

fastify.get("/leads", async (request, reply) => {
  const page = Number.parseInt(request.query.page) || 1
  const pageSize = Number.parseInt(request.query.pageSize) || 10
  const paginatedData = await getPaginatedLeadData(page, pageSize)
  reply.send(paginatedData)
})

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
      return
    } else {
      console.warn("Dev phone number is invalid.")
    }

    for (const phoneNumber of phoneNumbers) {
      if (phoneNumber && phoneNumber !== standardizedDevPhone) {
        console.log(`Initiating call to ${phoneNumber}`)
        const call = await makeOutgoingCall(phoneNumber, PHONE_NUMBER_FROM, `wss://${DOMAIN}/media-stream`)
        if (call) {
          console.log(`Successfully initiated call to ${phoneNumber}`)
        } else {
          console.log(`Skipped call to ${phoneNumber} due to error`)
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
    console.log("Finished initiating all calls")
  } catch (error) {
    console.error("Error initiating calls:", error)
  }
}

fastify.get("/start-calls", async (request, reply) => {
  console.log("Initiating calls to all numbers in the database")
  initiateCallsToAllNumbers()
    .then(() => reply.send({ message: "Calls initiated successfully" }))
    .catch((error) => reply.code(500).send({ error: "Failed to initiate calls" }))
})

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

fastify.get("/test-db-write", async (request, reply) => {
  const result = await testDatabaseWrite()
  if (result) {
    reply.send({ message: "Database write test successful" })
  } else {
    reply.code(500).send({ error: "Database write test failed" })
  }
})

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

fastify.get("/test-lead", async (request, reply) => {
  try {
    const testPhoneNumber = "+11234567890"
    const testEmail = "test@example.com"

    await addLead({
      phone_number: testPhoneNumber,
      email: testEmail,
      name: "Test User",
      status: "new",
    })

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

fastify.listen({ port: SERVER_PORT, host: "0.0.0.0" }, async (err) => {
  if (err) {
    console.error(err)
    process.exit(1)
  }
  console.log(`Server is listening on port ${SERVER_PORT}`)

  try {
    await initializeDatabase()
    console.log("Database initialized successfully")

    await ensureRecordingsDirExists()

    const twilioDevPhone = process.env.TWILIO_DEV_PHONE || "+16286666632"
    await addTwilioDevPhone(twilioDevPhone)
    console.log(`Twilio dev phone ${twilioDevPhone} added to the database`)

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

