# QuoteKill (Node.js)

Node/TypeScript port of the spec in [QUOTEKILL_MASTER_SPEC.md](QUOTEKILL_MASTER_SPEC.md). The spec is the source of truth; this repo follows its checkpoints. See [PROGRESS.md](PROGRESS.md) for what is built and what is next.

## Commands

```bash
npm install
npm test           # vitest
npm run typecheck
npm run gen-data   # writes data/ (see data/README.md): tuned seed 42, holdouts seed 7 and 8; deterministic
npm run summary    # prints the RFx line table and checks the baseline total
npm run dev        # the buyer UI on http://localhost:5173, API on 8787; reads the saved live runs, no key needed
npm run eval       # the eval harness on the saved runs; writes eval/report.md
```

The UI shows what the saved live runs in `data/runs/` produced (run `npm run extract` and `npm run evidence` to make them; they need the API key in `.env`). Buyer decisions in the UI (confirmations, verified or entered rates, gate waivers, confirmed awards) are stored in `data/app.db` (one file per data set) with an audit log; `npm run db -- reset` clears them.

Requires Node 20+. Vitest is pinned to 3.x because vitest 4+ needs a newer Node runtime.

## Stack

| Spec (Python) | Here |
|---|---|
| Pydantic | zod |
| pytest, hypothesis | vitest (fast-check later) |
| openpyxl | exceljs (generate and parse xlsx) |
| reportlab | pdfkit (generate PDFs) |
| pdfplumber / PyMuPDF | pdfjs-dist 4.10.38 (parse PDFs; 5.x needs Node 22) |
| email parsing | mailparser |
| python-docx | docx (generate) and fast-xml-parser (parse) |
| React, Vite, Tailwind, TanStack Table | React 18 and Vite 6 with plain CSS and a plain table (for now) |
| FastAPI | node:http (a handful of JSON routes) |
| PuLP/CBC, sqlglot, reportlab | to be chosen in their checkpoints |
