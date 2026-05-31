export default async function handler(req, res) {
  const query = (req.query.q || "").toString().toLowerCase().trim();

  const apiKey = process.env.EIA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "Missing EIA_API_KEY environment variable in Vercel."
    });
  }

  const datasets = [
    {
      title: "All top-level EIA datasets",
      route: "",
      keywords: "all datasets variables categories energy"
    },
    {
      title: "International Energy Statistics",
      route: "international",
      keywords: "international country countries world energy consumption production imports exports prices"
    },
    {
      title: "Electricity",
      route: "electricity",
      keywords: "electricity power generation retail sales prices consumption"
    },
    {
      title: "Electricity Retail Sales",
      route: "electricity/retail-sales",
      keywords: "electricity retail sales price revenue customers consumption state sector"
    },
    {
      title: "Petroleum",
      route: "petroleum",
      keywords: "oil petroleum gasoline diesel crude prices production consumption"
    },
    {
      title: "Natural Gas",
      route: "natural-gas",
      keywords: "natural gas prices production consumption storage"
    },
    {
      title: "Short-Term Energy Outlook",
      route: "steo",
      keywords: "forecast outlook energy prices oil gas electricity macro"
    },
    {
      title: "State Energy Data System",
      route: "seds",
      keywords: "state energy consumption production prices emissions"
    }
  ];

  const words = query.split(/\s+/).filter(Boolean);

  let matches = datasets.filter(item => {
    const text = (item.title + " " + item.route + " " + item.keywords).toLowerCase();
    return words.length === 0 || words.some(word => text.includes(word));
  });

  if (matches.length === 0) {
    matches = datasets;
  }

  try {
    const results = [];

    for (const item of matches.slice(0, 6)) {
      const url =
        "https://api.eia.gov/v2/" +
        item.route +
        "/?api_key=" +
        encodeURIComponent(apiKey);

      const response = await fetch(url);
      const data = await response.json();

      results.push({
        title: item.title,
        route: item.route || "/",
        eia_url_used: url.replace(apiKey, "HIDDEN_API_KEY"),
        metadata: data
      });
    }

    return res.status(200).json({
      query,
      note: "This searches EIA dataset routes and returns metadata. It does not yet pull final numeric series.",
      results
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error while contacting EIA API",
      details: error.message
    });
  }
}
