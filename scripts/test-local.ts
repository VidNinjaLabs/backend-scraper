import { decrypt } from "../utils/encryption";
import dotenv from "dotenv";

dotenv.config();

const API_SECRET = process.env.API_SECRET || "dev-secret-123";

async function testScrape() {
  console.log("🚀 Testing Scraper Endpoint...");

  // 1. Define payload (Movie: Dune Part Two)
  const payload = {
    media: {
      tmdbId: "693134",
      type: "movie",
      title: "Dune: Part Two",
      releaseYear: 2024,
    },
  };

  try {
    // 2. Send Request
    console.log("📡 Sending request to http://localhost:3000/scrape...");
    const response = await fetch("http://localhost:3000/scrape", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_SECRET}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text}`);
    }

    const data = await response.json();
    console.log(
      "🔒 Received Encrypted Data:",
      data.data.substring(0, 50) + "...",
    );

    // 3. Decrypt
    const decryptedJson = decrypt(data.data, API_SECRET);
    const result = JSON.parse(decryptedJson);

    console.log("\n✅ Decryption Successful!");
    console.log(`🎥 Stream Count: ${result.stream.length}`);
    if (result.stream.length > 0) {
      console.log(
        "📝 First Stream:",
        JSON.stringify(result.stream[0], null, 2),
      );
    }
  } catch (error) {
    console.error("❌ Test Failed:", error);
  }
}

testScrape();
