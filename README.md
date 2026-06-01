# EIA Energy Data Search

This is a small GitHub + Vercel web app that searches country-level energy data from the U.S. Energy Information Administration API.

The public webpage lets a user type a natural-language request such as:

- `Brazil energy consumption`
- `Jordan electricity generation`
- `compare Canada and Mexico natural gas production`
- `United States oil consumption`

The Vercel backend keeps the EIA API key private, calls the EIA API, ranks matching variables, returns actual observations, displays coverage, draws a chart, and lets the user download the selected data as CSV.

## File structure

```text
index.html
README.md
api/
  search-eia.js
  interpret-query.js
