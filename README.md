# Syrixa AI

This project is a custom-built, full-stack chatbot web application with Retrieval-Augmented Generation (RAG) capabilities. It allows users to chat with an AI and even upload files (like PDFs and text documents) so the AI can read, understand, and answer questions based on the document's content.

<img width="2844" height="1524" alt="Capture d’écran 2026-03-21 181918" src="https://github.com/user-attachments/assets/c8d49738-f500-4766-843d-7f34091412fc" />

## What is Syrixa AI?
Syrixa AI is the name of this intelligent chatbot. It leverages large language models (LLMs) via OpenRouter to provide conversational AI features directly within a clean, custom-built web interface. Think of it as a personal AI assistant that can learn from the files you provide it.

## What can we do with it?
- **Chat directly with the AI:** Ask questions, get coding help, or just have a conversation.
- **Upload Documents:** Upload `.pdf` or `.txt` files to give the AI context.
- **Document Q&A:** Ask the AI specific questions about the documents you uploaded, and it will retrieve the relevant information to answer you (RAG).
- **Test AI Models:** Easily switch between different AI models provided by OpenRouter by updating the environment file.

## What technologies are used?
This project was built without heavy frontend frameworks to keep things vanilla and straightforward for learning purposes:
- **Backend:** Node.js (Vanilla Node `http` server routing)
- **Frontend:** Vanilla JavaScript, HTML5, and CSS3
- **AI & Document Processing (RAG):** 
  - [LangChain](https://js.langchain.com/) for orchestrating the Retrieval-Augmented Generation (RAG) pipeline and handling text splitting.
  - `pdf-parse` for extracting text from PDF documents.
- **LLM Provider:** [OpenRouter API](https://openrouter.ai/) for routing AI model requests (e.g., using models like `openai/gpt-4o-mini`).

## How to Install
1. **Clone or download the project** to your local machine.
2. **Install dependencies:** Open your terminal in the project folder and run:
   ```bash
   npm install
   ```
3. **Set up Environment Variables:** Create a `.env` file in the root directory and add your API credentials using the following format:
   ```env
   OPENROUTER_API_KEY=your_openrouter_api_key_here
   OPENROUTER_MODEL=openai/gpt-4o-mini
   PORT=3000
   ```

## How to Use
1. **Start the server:**
   ```bash
   npm start
   ```
2. **Open the app:** Open your web browser and navigate to `http://localhost:3000`.
3. **Start chatting:** Type a message in the chat box or use the attachment icon to upload a document and ask questions about its content!

> **Note:** This is purely a personal project created to test AI capabilities and explore how everything works together! 🚀
