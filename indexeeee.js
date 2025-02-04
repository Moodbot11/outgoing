import fs from "node:fs"
import path from "node:path"
import { WebSocket } from "ws"
import Fastify from "fastify"
import { fileURLToPath } from "url"
import { dirname } from "path"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const RECORDINGS_DIR = path.join(__dirname, "recordings")
const OPENAI_API_KEY = process.env.OPENAI_API_KEY //Remember to set this environment variable

async function ensureRecordingsDirExists() {
  if (!fs.existsSync(RECORDINGS_DIR)) {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true })
  }
}

async function saveRecording(streamSid, incomingAudioBuffer, outgoingAudioBuffer) {
  console.log(`Attempting to save recording for StreamSID: ${streamSid}`)
  console.log(`Incoming audio buffer length: ${incomingAudioBuffer.length}`)
  console.log(`Outgoing audio buffer length: ${outgoingAudioBuffer.length}`)
  await ensureRecordingsDirExists()
  const timestamp = new Date().toISOString().replace(/:/g, "-")
  const incomingFileName = `${streamSid}_incoming_${timestamp}.raw`
  const outgoingFileName = `${streamSid}_outgoing_${timestamp}.raw`
  const incomingFilePath = path.join(RECORDINGS_DIR, incomingFileName)
  const outgoingFilePath = path.join(RECORDINGS_DIR, outgoingFileName)

  // Save incoming audio
  fs.writeFileSync(incomingFilePath, incomingAudioBuffer)
  console.log(`Incoming audio saved as raw PCM for StreamSID: ${streamSid}`)

  // Save outgoing audio
  fs.writeFileSync(outgoingFilePath, outgoingAudioBuffer)
  console.log(`Outgoing audio saved as raw PCM for StreamSID: ${streamSid}`)

  console.log(`Recordings saved for StreamSID: ${streamSid}`)
  return { incomingFilePath, outgoingFilePath }
}

const fastify = Fastify()

fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection, req) => {
    console.log("Client connected")

    let streamSid = null
    let customerNumber = null
    let latestMediaTimestamp = 0
    let lastAssistantItem = null
    const markQueue = []
    let responseStartTimestampTwilio = null
    const accumulatedText = ""
    const customerNumbers = new Map()
    const silenceTimeout = null
    let incomingAudioBuffer = Buffer.alloc(0)
    let outgoingAudioBuffer = Buffer.alloc(0)

    const openAiWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01", {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    })

    // initializeSession, sendMark, handleEndOfSpeech, and promptAIIfSilent would go here.  These are not provided in the update.  Placeholders are used below.

    const initializeSession = () => {
      console.log("Session Initialized")
    }
    const sendMark = (connection, streamSid) => {
      console.log("Mark Sent")
    }
    const handleEndOfSpeech = () => {
      console.log("End of Speech")
    }
    const promptAIIfSilent = () => {
      console.log("Prompting AI")
    }

    openAiWs.on("message", async (data) => {
      try {
        const response = JSON.parse(data)
        console.log("Received OpenAI event:", response.type)

        //Handle text responses would go here. Placeholder below.
        if (response.type === "response.text.delta") {
          console.log("Received text delta:", response.delta)
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
            if (data.media.track === "inbound") {
              incomingAudioBuffer = Buffer.concat([incomingAudioBuffer, Buffer.from(data.media.payload, "base64")])
              console.log(`Incoming audio buffer length: ${incomingAudioBuffer.length}`)

              if (openAiWs.readyState === WebSocket.OPEN) {
                const audioAppend = {
                  type: "input_audio_buffer.append",
                  audio: data.media.payload,
                }
                openAiWs.send(JSON.stringify(audioAppend))
              }
            }
            if (!customerNumbers.has(data.streamSid)) {
              console.log(`Call in progress: ${customerNumber}`)
              customerNumbers.set(data.streamSid, customerNumber)
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
            if (incomingAudioBuffer.length > 0 || outgoingAudioBuffer.length > 0) {
              try {
                console.log(`Saving recording for StreamSID: ${streamSid}`)
                const filePaths = await saveRecording(streamSid, incomingAudioBuffer, outgoingAudioBuffer)
                console.log(`Recording saved successfully for StreamSID: ${streamSid}`)
                console.log(`Incoming audio saved at: ${filePaths.incomingFilePath}`)
                console.log(`Outgoing audio saved at: ${filePaths.outgoingFilePath}`)
              } catch (error) {
                console.error(`Error saving recording for StreamSID: ${streamSid}:`, error)
              }
              incomingAudioBuffer = Buffer.alloc(0)
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

    //Connection close and error handling would go here. Placeholders below.
    connection.on("close", () => {
      console.log("Connection Closed")
    })
    openAiWs.on("error", (error) => {
      console.error("OpenAI WebSocket Error:", error)
    })
    connection.on("error", (error) => {
      console.error("Twilio WebSocket Error:", error)
    })
    openAiWs.on("close", () => {
      console.log("OpenAI WebSocket Closed")
    })
  })
})

//Start the fastify server.  This needs to be added to the end of the file.
const start = async () => {
  try {
    await fastify.listen({ port: 3000, host: "0.0.0.0" })
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}
start()

