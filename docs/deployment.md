# Deployment Guide - Syrixa AI

This guide covers how to deploy the Syrixa AI chat bot to various platforms.

The Node process handles **SIGTERM** / **SIGINT** by closing the HTTP server before exit, which plays nicely with Docker and process managers (see `server.js`).

## Prerequisites

- An [OpenRouter](https://openrouter.ai/) API Key.
- (Optional) Docker installed on your machine or deployment server.

## 🐳 Deployment with Docker (Recommended)

Docker is the most consistent way to deploy Syrixa AI. The included `Dockerfile` defines a **HEALTHCHECK** that hits `/` so orchestrators can restart unhealthy containers automatically.

1.  **Build the image:**
    ```bash
    docker build -t syrixa-ai .
    ```

2.  **Run the container:**
    ```bash
    docker run -d \
      -p 3000:3000 \
      -e OPENROUTER_API_KEY="your_api_key_here" \
      --name syrixa-app \
      syrixa-ai
    ```

## 🚀 Cloud Platforms

### Railway (Easiest)
1.  Connect your GitHub repository to [Railway](https://railway.app/).
2.  Add the `OPENROUTER_API_KEY` to the service variables.
3.  Railway will automatically detect the `Dockerfile` or `package.json` and deploy.

### Render / Fly.io
1.  Create a new Web Service and connect your repository.
2.  Set the environment variable `OPENROUTER_API_KEY`.
3.  Set the Build Command to `npm install` and Start Command to `npm start`.

### Vercel
> [!IMPORTANT]
> Because this is a long-running Node.js server with file uploads, it is better suited for a persistent server or container than Vercel's Serverless Functions. However, you can deploy the frontend, but the backend would need to be hosted elsewhere.

## ⚠️ Important Notes on Persistence

- **RAG Data**: Currently, processed documents are stored in-memory. If the server restarts, you will need to re-upload documents to use them in the chat.
- **Uploads**: The `uploads/` directory is used temporarily during document processing. For serverless deployments, this might need to be pointed to `/tmp`.

## 🔒 Security

The server is configured with:
- **CORS**: Restricted or open depending on your needs (currently open `*`).
- **Security Headers**: Includes CSP, XSS protection, and frame options.
- **Graceful shutdown**: On `SIGTERM` or `SIGINT`, the server stops accepting new connections and exits after existing requests finish (with a 10s safety timeout).
