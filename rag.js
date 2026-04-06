'use strict';

/**
 * RAG (retrieval-augmented generation) pipeline for Syrixa.
 *
 * Uploaded PDFs or text files get split into chunks, embedded via OpenRouter-compatible
 * embeddings, and stored in a simple in-memory vector index keyed by document id.
 * When the user chats with a document attached, the server pulls the most relevant
 * chunks and injects them into the system prompt so the model can answer from the file.
 */

const fs = require('fs');
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { Document } = require('@langchain/core/documents');
const { v4: uuidv4 } = require('uuid');

/** Chunk size tuned so each embedding still fits model limits while staying semantically meaningful. */
const TEXT_CHUNK_SIZE = 1000;
/** Overlap keeps sentences that span chunk boundaries from being cut in half context-wise. */
const TEXT_CHUNK_OVERLAP = 200;
/** How many best-matching chunks we send back to the chat handler as context. */
const DEFAULT_TOP_K = 3;

/**
 * LangChain embeddings client pointed at OpenRouter (same key as chat completions).
 * We use a small, cheap embedding model; quality is enough for short document Q&A.
 */
const embeddings = new OpenAIEmbeddings({
  openAIApiKey: process.env.OPENROUTER_API_KEY || 'fake',
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1',
  },
  modelName: 'openai/text-embedding-3-small',
});

/**
 * Cosine similarity between two embedding vectors (same length).
 * Used to rank which stored chunks are closest to the user's question.
 *
 * @param {number[]} A
 * @param {number[]} B
 * @returns {number} Similarity in [-1, 1], higher is more similar; 0 if either vector has zero length.
 */
function cosineSimilarity(A, B) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < A.length; i++) {
    dotProduct += A[i] * B[i];
    normA += A[i] * A[i];
    normB += B[i] * B[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (!denom) return 0;
  return dotProduct / denom;
}

/**
 * Minimal in-memory vector store: no database, just an array of { content, vector }.
 * Good for demos and single-server deploys; data is lost on restart (see deployment docs).
 */
class SimpleVectorStore {
  /**
   * @param {import('@langchain/openai').OpenAIEmbeddings} embeddingsModel
   */
  constructor(embeddingsModel) {
    this.embeddingsModel = embeddingsModel;
    /** @type {{ content: string, vector: number[] }[]} */
    this.docs = [];
  }

  /**
   * Builds a store from LangChain documents by embedding all chunk texts in one batch.
   *
   * @param {import('@langchain/core/documents').Document[]} docs
   * @param {import('@langchain/openai').OpenAIEmbeddings} embeddingsModel
   */
  static async fromDocuments(docs, embeddingsModel) {
    const store = new SimpleVectorStore(embeddingsModel);
    const contents = docs.map((d) => d.pageContent);
    const vectors = await embeddingsModel.embedDocuments(contents);
    for (let i = 0; i < docs.length; i++) {
      store.docs.push({ content: docs[i].pageContent, vector: vectors[i] });
    }
    return store;
  }

  /**
   * Embeds the query string, scores every chunk, returns the top `k` by cosine similarity.
   *
   * @param {string} query
   * @param {number} [k]
   * @returns {Promise<{ pageContent: string }[]>}
   */
  async similaritySearch(query, k = DEFAULT_TOP_K) {
    const queryVector = await this.embeddingsModel.embedQuery(query);
    const scoredDocs = this.docs.map((doc) => ({
      content: doc.content,
      score: cosineSimilarity(doc.vector, queryVector),
    }));
    scoredDocs.sort((a, b) => b.score - a.score);
    return scoredDocs.slice(0, k).map((d) => ({ pageContent: d.content }));
  }
}

/** Map documentId -> vector store instance for the lifetime of the Node process. */
const vectorStores = new Map();

/**
 * Reads a file from disk (PDF or plain text), chunks it, embeds chunks, and registers a new id.
 *
 * @param {string} filePath Absolute path to the temp upload on disk
 * @param {string} mimeType MIME type from the multipart upload
 * @returns {Promise<string>} New uuid for this document session
 */
async function processDocument(filePath, mimeType) {
  let text = '';

  if (mimeType === 'application/pdf' || filePath.endsWith('.pdf')) {
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    text = pdfData.text;
  } else {
    text = fs.readFileSync(filePath, 'utf8');
  }

  if (!text.trim()) {
    throw new Error('Document is empty or could not be read.');
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: TEXT_CHUNK_SIZE,
    chunkOverlap: TEXT_CHUNK_OVERLAP,
  });

  const chunks = await splitter.splitText(text);
  const docs = chunks.map((chunk) => new Document({ pageContent: chunk }));

  const vectorStore = await SimpleVectorStore.fromDocuments(docs, embeddings);

  const documentId = uuidv4();
  vectorStores.set(documentId, vectorStore);

  return documentId;
}

/**
 * Retrieves the top matching chunks for the user's latest message and concatenates them.
 * Returns null if the document id is unknown (e.g. server restarted).
 *
 * @param {string} documentId
 * @param {string} query
 * @returns {Promise<string|null>}
 */
async function queryDocument(documentId, query) {
  const vectorStore = vectorStores.get(documentId);
  if (!vectorStore) {
    return null;
  }

  const results = await vectorStore.similaritySearch(query, DEFAULT_TOP_K);
  const contextText = results.map((r) => r.pageContent).join('\n\n');
  return contextText;
}

module.exports = {
  processDocument,
  queryDocument,
};
