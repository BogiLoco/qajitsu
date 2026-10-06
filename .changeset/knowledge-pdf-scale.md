---
"@qajitsu/cli": minor
"@qajitsu/adapter-knowledge-lancedb": patch
---

PDF documents with a text layer are added to the knowledge base page by page (scans are skipped with the reason). The LanceDB store selects its score columns explicitly; a scale benchmark (`bench/knowledge-scale.mjs`) measures search on 1 million chunks.
