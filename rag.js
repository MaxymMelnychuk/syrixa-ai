const fs = require('fs');
const pdfParse = require('pdf-parse');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { OpenAIEmbeddings } = require('@langchain/openai');
const { Document } = require('@langchain/core/documents');
const { v4: uuidv4 } = require('uuid');

const embeddings = new OpenAIEmbeddings({
  openAIApiKey: process.env.OPENROUTER_API_KEY || 'fake',
  configuration: {
    baseURL: 'https://openrouter.ai/api/v1'
  },
  modelName: 'openai/text-embedding-3-small' 
});

function cosineSimilarity(A, B) {
  let dotProduct = 0, normA = 0, normB = 0;
  for (let i = 0; i < A.length; i++) {
    dotProduct += A[i] * B[i];
    normA += A[i] * A[i];
    normB += B[i] * B[i];
  }
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

class SimpleVectorStore {
  constructor(embeddingsModel) {
    this.embeddingsModel = embeddingsModel;
    this.docs = [];
  }

  static async fromDocuments(docs, embeddingsModel) {
    const store = new SimpleVectorStore(embeddingsModel);
    const contents = docs.map(d => d.pageContent);
    const vectors = await embeddingsModel.embedDocuments(contents);
    for (let i = 0; i < docs.length; i++) {
      store.docs.push({ content: docs[i].pageContent, vector: vectors[i] });
    }
    return store;
  }

  async similaritySearch(query, k = 3) {
    const queryVector = await this.embeddingsModel.embedQuery(query);
    const scoredDocs = this.docs.map(doc => ({
      content: doc.content,
      score: cosineSimilarity(doc.vector, queryVector)
    }));
    scoredDocs.sort((a, b) => b.score - a.score);
    return scoredDocs.slice(0, k).map(d => ({ pageContent: d.content }));
  }
}

const vectorStores = new Map();

async function processDocument(filePath, mimeType) {
  let text = '';

  if (mimeType === 'application/pdf' || filePath.endsWith('.pdf')) {
    const dataBuffer = fs.readFileSync(filePath);
    const pdfData = await pdfParse(dataBuffer);
    text = pdfData.text;
  } else {
    // Treat as raw text
    text = fs.readFileSync(filePath, 'utf8');
  }

  if (!text.trim()) {
    throw new Error('Document is empty or could not be read.');
  }

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 200,
  });

  const chunks = await splitter.splitText(text);
  const docs = chunks.map(chunk => new Document({ pageContent: chunk }));

  const vectorStore = await SimpleVectorStore.fromDocuments(docs, embeddings);
  
  const documentId = uuidv4();
  vectorStores.set(documentId, vectorStore);
  
  return documentId;
}

async function queryDocument(documentId, query) {
  const vectorStore = vectorStores.get(documentId);
  if (!vectorStore) {
    return null;
  }

  const results = await vectorStore.similaritySearch(query, 3);
  const contextText = results.map(r => r.pageContent).join('\n\n');
  return contextText;
}

module.exports = {
  processDocument,
  queryDocument
};
