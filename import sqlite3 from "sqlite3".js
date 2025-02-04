import sqlite3 from "sqlite3"
import { open } from "sqlite"
import fs from "fs"
import csv from "csv-parser"
import dotenv from "dotenv"

// Load environment variables
dotenv.config()

let db

async function initializeDatabase() {
  try {
    const dbPath = process.env.DATABASE_PATH || "./leads.sqlite"
    console.log(`Attempting to open database at: ${dbPath}`)

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    })
    console.log("Database connection established successfully")

    await db.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT,
        lead_id TEXT,
        name TEXT,
        phone_number TEXT,
        email TEXT,
        language TEXT,
        alternate_phone TEXT,
        address TEXT,
        city TEXT,
        country TEXT,
        state TEXT,
        customer_type TEXT,
        new_customer TEXT,
        product_type TEXT,
        status TEXT,
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lead_id INTEGER,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        content TEXT,
        is_ai_response INTEGER DEFAULT 0,
        FOREIGN KEY (lead_id) REFERENCES leads (id)
      );
    `)
    console.log("Database tables created or verified")
  } catch (error) {
    console.error("Error initializing database:", error)
    throw error
  }
}

async function importCSV(filePath) {
  return new Promise((resolve, reject) => {
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", async (row) => {
        try {
          const phoneNumber = standardizePhoneNumber(row["262-691-2510"])
          if (phoneNumber) {
            await db.run(
              `
              INSERT INTO leads (
                date, lead_id, name, phone_number, language, alternate_phone,
                address, city, country, state, customer_type, new_customer,
                product_type, status, last_updated
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            `,
              [
                row["1"],
                row["53072"],
                row["KENNETH ORLOWSKI"],
                phoneNumber,
                row["EN"],
                "", // We're not using the alternate_phone for now
                row["1077 CECILIA DRIVE"],
                row["PEWAUKEE"],
                row["USA"],
                row["WI"],
                row["CU"],
                row["N"],
                row["PRM"],
                "new",
              ],
            )
          } else {
            console.warn(`Skipping row with invalid phone number: ${row["262-691-2510"]}`)
          }
        } catch (err) {
          console.error("Error inserting row:", err)
        }
      })
      .on("end", () => {
        console.log("CSV file successfully processed")
        resolve()
      })
      .on("error", (error) => {
        reject(error)
      })
  })
}

async function addLead(leadData) {
  const {
    date,
    lead_id,
    name,
    phone_number,
    language,
    alternate_phone,
    address,
    city,
    country,
    state,
    customer_type,
    new_customer,
    product_type,
    status = "new",
    email,
  } = leadData

  const standardizedPhoneNumber = standardizePhoneNumber(phone_number)
  if (!standardizedPhoneNumber) {
    console.warn(`Skipping lead with invalid phone number: ${phone_number}`)
    return
  }

  await db.run(
    `
    INSERT OR REPLACE INTO leads (
      date, lead_id, name, phone_number, language, alternate_phone, email,
      address, city, country, state, customer_type, new_customer,
      product_type, status, last_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  `,
    [
      date,
      lead_id,
      name,
      standardizedPhoneNumber,
      language,
      alternate_phone,
      email,
      address,
      city,
      country,
      state,
      customer_type,
      new_customer,
      product_type,
      status,
    ],
  )
}

async function getLead(phoneNumber) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) return null

  const lead = await db.get("SELECT * FROM leads WHERE phone_number = ? OR alternate_phone = ?", [
    standardizedPhoneNumber,
    standardizedPhoneNumber,
  ])
  console.log(`Retrieved lead for ${standardizedPhoneNumber}:`, lead)
  return lead
}

async function updateLeadStatus(phoneNumber, status) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) {
    console.warn(`Cannot update status for invalid phone number: ${phoneNumber}`)
    return
  }

  const result = await db.run(
    "UPDATE leads SET status = ?, last_updated = CURRENT_TIMESTAMP WHERE phone_number = ? OR alternate_phone = ?",
    [status, standardizedPhoneNumber, standardizedPhoneNumber],
  )
  console.log(`Updated status for ${standardizedPhoneNumber} to ${status}. Rows affected: ${result.changes}`)
}

async function addConversation(phoneNumber, content, isAiResponse = false) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) {
    console.warn(`Cannot add conversation for invalid phone number: ${phoneNumber}`)
    return
  }

  const lead = await getLead(standardizedPhoneNumber)
  if (lead) {
    // Only store meaningful content
    if (content !== "User audio received" || isAiResponse) {
      await db.run("INSERT INTO conversations (lead_id, content, is_ai_response) VALUES (?, ?, ?)", [
        lead.id,
        content,
        isAiResponse ? 1 : 0,
      ])
      await db.run("UPDATE leads SET last_updated = CURRENT_TIMESTAMP WHERE id = ?", [lead.id])

      // If this is an AI response, check for email
      if (isAiResponse && content.includes("email:")) {
        const emailMatch = content.match(/email:\s*([^\s]+@[^\s]+)/i)
        if (emailMatch && emailMatch[1]) {
          await updateLeadEmail(standardizedPhoneNumber, emailMatch[1])
          console.log(`Email updated for ${standardizedPhoneNumber}: ${emailMatch[1]}`)
        }
      }
    }
  }
}

async function getConversationHistory(phoneNumber) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) return []

  const lead = await getLead(standardizedPhoneNumber)
  if (lead) {
    return await db.all("SELECT * FROM conversations WHERE lead_id = ? ORDER BY timestamp DESC", [lead.id])
  }
  return []
}

async function getLeadData(phoneNumber) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) return null

  const lead = await getLead(standardizedPhoneNumber)
  if (lead) {
    // Only get meaningful conversations (exclude "User audio received")
    const conversations = await db.all(
      "SELECT * FROM conversations WHERE lead_id = ? AND (is_ai_response = 1 OR content != 'User audio received') ORDER BY timestamp ASC",
      [lead.id],
    )
    return { ...lead, conversations }
  }
  return null
}

async function getPaginatedLeadData(page = 1, pageSize = 10) {
  const offset = (page - 1) * pageSize
  const leads = await db.all(
    `
    SELECT * FROM leads
    ORDER BY last_updated DESC
    LIMIT ? OFFSET ?
  `,
    [pageSize, offset],
  )

  for (const lead of leads) {
    // Only get AI responses and actual conversation content
    lead.conversations = await db.all(
      `SELECT 
        id,
        lead_id,
        timestamp,
        content,
        is_ai_response
       FROM conversations 
       WHERE lead_id = ? 
       AND content != 'User audio received'
       AND is_ai_response = 1
       ORDER BY timestamp ASC`,
      [lead.id],
    )
  }

  const totalCount = await db.get("SELECT COUNT(*) as count FROM leads")
  const totalPages = Math.ceil(totalCount.count / pageSize)

  return {
    leads: leads.map((lead) => ({
      id: lead.id,
      name: lead.name,
      phone_number: lead.phone_number,
      email: lead.email || null,
      status: lead.status,
      last_updated: lead.last_updated,
      conversations: lead.conversations,
    })),
    currentPage: page,
    totalPages,
    pageSize,
  }
}

async function getAllPhoneNumbers() {
  const rows = await db.all("SELECT phone_number FROM leads")
  const phoneNumbers = rows
    .map((row) => row.phone_number)
    .filter(Boolean)
    .flatMap((number) => {
      if (number.includes("/")) {
        return number.split("/").map((n) => n.trim())
      }
      return [number]
    })
  return [...new Set(phoneNumbers.map(standardizePhoneNumber).filter(Boolean))]
}

function standardizePhoneNumber(number) {
  if (!number) return null

  // Remove all non-digit characters
  const digitsOnly = number.replace(/\D/g, "")

  // Check if the number starts with '1' (country code for US)
  if (digitsOnly.length === 11 && digitsOnly.startsWith("1")) {
    return `+${digitsOnly}`
  } else if (digitsOnly.length === 10) {
    return `+1${digitsOnly}`
  } else {
    console.warn(`Unusual phone number format: ${number}`)
    return null
  }
}

async function updatePhoneNumberFormat(oldNumber, newNumber) {
  const standardizedOldNumber = standardizePhoneNumber(oldNumber)
  const standardizedNewNumber = standardizePhoneNumber(newNumber)

  if (!standardizedOldNumber || !standardizedNewNumber) {
    console.warn(`Cannot update phone number format: invalid number(s)`)
    return
  }

  await db.run("UPDATE leads SET phone_number = ? WHERE phone_number = ?", [
    standardizedNewNumber,
    standardizedOldNumber,
  ])
  await db.run("UPDATE leads SET alternate_phone = ? WHERE alternate_phone = ?", [
    standardizedNewNumber,
    standardizedOldNumber,
  ])
}

async function addTwilioDevPhone(phoneNumber) {
  const standardizedNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedNumber) {
    throw new Error("Invalid Twilio dev phone number")
  }

  await db.run(
    `
    INSERT OR REPLACE INTO leads (
      phone_number, name, status, last_updated
    ) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
  `,
    [standardizedNumber, "Twilio Dev Phone", "new"],
  )
}

async function updateLeadEmail(phoneNumber, email) {
  const standardizedPhoneNumber = standardizePhoneNumber(phoneNumber)
  if (!standardizedPhoneNumber) {
    console.warn(`Cannot update email for invalid phone number: ${phoneNumber}`)
    return null
  }

  try {
    console.log(`Attempting to update email for ${standardizedPhoneNumber} to ${email}`)

    // First, let's log the current lead data
    const currentLead = await getLead(standardizedPhoneNumber)
    console.log(`Current lead data for ${standardizedPhoneNumber}:`, currentLead)

    const result = await db.run(
      "UPDATE leads SET email = ?, last_updated = CURRENT_TIMESTAMP WHERE phone_number = ? OR alternate_phone = ?",
      [email, standardizedPhoneNumber, standardizedPhoneNumber],
    )
    console.log(`Update query executed. Rows affected: ${result.changes}`)

    if (result.changes === 0) {
      console.log(`No existing lead found for ${standardizedPhoneNumber}. Inserting new lead.`)
      await db.run(
        "INSERT INTO leads (phone_number, email, status, last_updated) VALUES (?, ?, 'new', CURRENT_TIMESTAMP)",
        [standardizedPhoneNumber, email],
      )
      console.log(`Inserted new lead for ${standardizedPhoneNumber} with email ${email}`)
    }

    // Verify the update
    const updatedLead = await getLead(standardizedPhoneNumber)
    console.log(`Lead after update/insert:`, updatedLead)

    // Simple test to check if the email was actually updated
    if (updatedLead && updatedLead.email === email) {
      console.log(`SUCCESS: Email successfully updated to ${email} for ${standardizedPhoneNumber}`)
    } else {
      console.error(
        `ERROR: Email update failed for ${standardizedPhoneNumber}. Expected ${email}, got ${updatedLead ? updatedLead.email : "null"}`,
      )
    }

    return updatedLead
  } catch (error) {
    console.error(`Error updating/inserting email for ${standardizedPhoneNumber}:`, error)
    throw error
  }
}

async function testDatabaseWrite() {
  try {
    const testPhoneNumber = "+11234567890"
    const testEmail = "test@example.com"

    console.log(`Testing database write with phone: ${testPhoneNumber}, email: ${testEmail}`)

    const result = await updateLeadEmail(testPhoneNumber, testEmail)

    if (result && result.email === testEmail) {
      console.log("Database write test successful")
      return true
    } else {
      console.error("Database write test failed")
      return false
    }
  } catch (error) {
    console.error("Error during database write test:", error)
    return false
  }
}

export {
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
  updatePhoneNumberFormat,
  standardizePhoneNumber,
  addTwilioDevPhone,
  updateLeadEmail,
  testDatabaseWrite,
}

