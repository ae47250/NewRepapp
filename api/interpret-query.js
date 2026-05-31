export default async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const query = getQuery(req);

  if (!query) {
    return res.status(400).json({
      error: "Missing query. Example: Brazil energy consumption."
    });
  }

  if (!apiKey) {
    return res.status(200).json({
      originalQuery: query,
      searchQuery: query,
      aiUsed: false,
      warning: "Missing OPENAI_API_KEY environment variable in Vercel. Used original query instead."
    });
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + apiKey
      },
      body: JSON.stringify({
        model,
        input: [
          {
            role: "system",
            content:
              "You interpret natural-language searches for the U.S. Energy Information Administration API. Return only one valid JSON object. No markdown. No extra text. Convert casual wording into a short EIA search phrase."
          },
          {
            role: "user",
            content:
              "User query: " + query + "\n\n" +
              "Return JSON with these exact fields:\n" +
              "{\n" +
              "  \"originalQuery\": string,\n" +
              "  \"searchQuery\": string,\n" +
              "  \"country\": string,\n" +
              "  \"countryIso\": string,\n" +
              "  \"topic\": string,\n" +
              "  \"product\": string,\n" +
              "  \"activity\": string,\n" +
              "  \"frequency\": string,\n" +
              "  \"observations\": number|null,\n" +
              "  \"needsClarification\": boolean,\n" +
              "  \"clarificationQuestion\": string\n" +
              "}\n\n" +
              "Rules:\n" +
              "- Keep searchQuery short, like 'United States energy consumption'.\n" +
              "- Use country name, not slang, in searchQuery.\n" +
              "- 'usa', 'us', and 'america' mean United States.\n" +
              "- 'power' usually means electricity.\n" +
              "- 'gas' usually means natural gas unless gasoline is clearly implied.\n" +
              "- 'energy' by itself usually means primary energy.\n" +
              "- Use annual frequency unless the user clearly asks otherwise.\n" +
              "- Use 10 observations for recent/latest/last decade; otherwise null."
          }
        ],
        text: {
          format: {
            type: "json_object"
          }
        },
        store: false
      })
    });

    const rawText = await response.text();
    let apiJson;

    try {
      apiJson = JSON.parse(rawText);
    } catch {
      throw new Error("OpenAI returned non-JSON response: " + rawText.slice(0, 300));
    }

    if (!response.ok) {
      const message =
        apiJson?.error?.message ||
        apiJson?.error ||
        "OpenAI API request failed.";

      throw new Error(message);
    }

    const outputText = extractOutputText(apiJson);

    if (!outputText) {
      throw new Error("OpenAI response did not contain output text.");
    }

    const interpreted = JSON.parse(outputText);
    const cleaned = cleanInterpretation(query, interpreted);

    return res.status(200).json(cleaned);
  } catch (error) {
    return res.status(200).json({
      originalQuery: query,
      searchQuery: query,
      aiUsed: false,
      warning: "AI interpretation failed. Used original query instead.",
      details: error.message
    });
  }
}

function getQuery(req) {
  if (req.method === "POST") {
    return String(req.body?.q || req.body?.query || "").trim();
  }

  return String(req.query.q || req.query.query || "").trim();
}

function extractOutputText(apiJson) {
  if (typeof apiJson.output_text === "string" && apiJson.output_text.trim()) {
    return apiJson.output_text.trim();
  }

  if (!Array.isArray(apiJson.output)) {
    return "";
  }

  const parts = [];

  for (const item of apiJson.output) {
    if (!Array.isArray(item.content)) continue;

    for (const contentItem of item.content) {
      if (typeof contentItem.text === "string") {
        parts.push(contentItem.text);
      }
    }
  }

  return parts.join("\n").trim();
}

function cleanInterpretation(originalQuery, interpreted) {
  const country = cleanString(interpreted.country);
  const topic = cleanString(interpreted.topic);
  const product = cleanString(interpreted.product);
  const activity = cleanString(interpreted.activity);

  let searchQuery = cleanString(interpreted.searchQuery);

  if (!searchQuery) {
    searchQuery = [country, topic || product, activity]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  if (!searchQuery) {
    searchQuery = originalQuery;
  }

  return {
    originalQuery,
    searchQuery,
    country,
    countryIso: cleanString(interpreted.countryIso).toUpperCase(),
    topic,
    product,
    activity,
    frequency: cleanString(interpreted.frequency) || "Annual",
    observations: normalizeObservations(interpreted.observations),
    needsClarification: Boolean(interpreted.needsClarification),
    clarificationQuestion: cleanString(interpreted.clarificationQuestion),
    aiUsed: true
  };
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function normalizeObservations(value) {
  if (value === null || value === undefined || value === "") return null;

  const number = Number(value);

  if (!Number.isFinite(number) || number <= 0) return null;

  return Math.round(number);
}
