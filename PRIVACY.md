# Privacy Policy — agentic-recall

_Last updated: 2026-09-08_

agentic-recall is a local MCP server. It runs on your own machine, reads and writes files in
folders you choose, and is not backed by any service operated by the author.

Every statement below was checked against the source before it was written here.

## What data it handles

- **Your memories.** Plain markdown files in the folder you point `MEMORY_DIR` at. You create them,
  you can read, edit, `git diff` and delete them with ordinary tools.
- **Captured conversations, if you switch capture on.** Exchanges from your Claude transcripts,
  written as markdown into a store directory you configure. Off unless you install the hooks.
- **Derived indexes.** Search indexes and an embedding cache, written beside the corpus.
- **Local instrumentation.** A query log and shadow-measurement files, used to tune retrieval.

## Where it goes

Nowhere. All of the above is written to disk on your machine and read back from it.

The server makes **no network requests** in normal operation. There is exactly one outbound
connection in the whole product: the first time it builds an index it downloads an open-source
embedding model (`Xenova/bge-small-en-v1.5`, about 33 MB) through the `@xenova/transformers`
library. After that the model is cached locally and inference runs on your CPU. Your memories,
your queries and your results are never sent anywhere, including to the author.

There is **no telemetry, no analytics, no crash reporting and no phone-home**. The files named
"telemetry" in this repository write to local disk and transmit nothing.

## Third-party sharing

None. The author receives no data from your installation and has no means of doing so. The only
third party involved at all is whoever hosts the model download on first run; that request carries
no information about you or your corpus beyond an ordinary file fetch.

## Retention and deletion

Your data stays until you delete it. Memories are files: remove the folder and it is gone. Indexes
and the embedding cache are derived and can be deleted at any time; they rebuild on the next index.
The author retains nothing, so there is nothing to request deletion of.

## Credentials found in your own text

Because captured conversations can contain secrets you typed, the server scrubs credential-shaped
strings before writing them to the store, and refuses to index files you denylist. This is a
safeguard, not a guarantee — treat your memory folder as you would any other directory of personal
notes, and keep it out of public repositories.

## Contact

Questions, or anything that looks wrong: open an issue at
<https://github.com/dfrancislyondflabc-tech/agentic-recall/issues> or email
danfrancislyon@gmail.com.
