import fs from "fs"
import fetch from "node-fetch"
import FormData from "form-data"
import dotenv from "dotenv"

dotenv.config()

const OPENAI_API_KEY = process.env.OPENAI_API_KEY

export async function transcribeAudio(filePath) {
  const form = new FormData()
  form.append("file", fs.createReadStream(filePath))
  form.append("model", "whisper-1")
  form.append("language", "en")

  try {
    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const result = await response.json()
    return result.text
  } catch (error) {
    console.error("Error transcribing audio:", error)
    throw error
  }
}

