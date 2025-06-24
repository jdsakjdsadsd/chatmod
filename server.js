import { MongoClient, ServerApiVersion } from 'mongodb';
import express from 'express';
import dotenv from 'dotenv';
import cors from 'cors';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

dotenv.config();
const mongoUri = process.env.MONGO_URI;
let db;

async function connectDB() {
  if (db) return db;
  if (!mongoUri) {
    console.error('MONGO_URI não definida!');
    process.exit(1);
  }
  const client = new MongoClient(mongoUri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true },
  });
  await client.connect();
  db = client.db("ifcodeLogsDB");
  console.log("Conectado ao MongoDB Atlas!");
  return db;
}

// Conecta ao iniciar
connectDB();


const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error("A variável de ambiente GEMINI_API_KEY não está definida.");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(apiKey);

const functions = [
  {
    name: "getCurrentTime",
    description: "Retorna a data e hora atual no formato pt-BR",
    parameters: {
      type: "object",
      properties: {},
      required: []
    }
  }
];

function getCurrentTime() {
  console.log("FUNÇÃO LOCAL: getCurrentTime() foi chamada.");
  const now = new Date();
  return { currentTime: now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) };
}

const availableFunctions = {
  getCurrentTime: getCurrentTime
};

app.post('/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    if (!message) {
      return res.status(400).json({ error: "A mensagem é obrigatória." });
    }

    const model = genAI.getGenerativeModel({
      model: "gemini-2.0-flash",
      functions,
      safetySettings: [
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ],
    });

    const chatHistory = history ? history.map(h => ({
      role: h.author === 'model' ? 'model' : 'user',
      parts: [{ text: h.content }]
    })) : [];

    const chat = model.startChat({ history: chatHistory });

    console.log("Enviando mensagem para o Gemini:", message);

    const systemPrompt = "Quando o usuário perguntar sobre hora ou data atual, chame a função getCurrentTime para fornecer a resposta correta.";

    const fullMessage = `${systemPrompt}\n\n${message}`;

    const result = await chat.sendMessage({
      role: 'user',
      parts: [{ text: fullMessage }]
    }, { functionCall: 'auto' });

    const geminiResponse = result.response;

    const functionCalls = geminiResponse.functionCalls();

    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      console.log(`GEMINI SOLICITOU FUNÇÃO: ${call.name}`);
      console.log("Argumentos da função:", call.args);

      const functionToCall = availableFunctions[call.name];

      if (functionToCall) {
        const functionResultData = functionToCall(call.args);
        console.log("Resultado da função local:", functionResultData);

        const followUpResult = await chat.sendMessage({
          functionResponse: {
            name: call.name,
            response: functionResultData
          }
        });

        console.log("Resposta do Gemini após execução da função:", followUpResult.response.text());

        return res.json({
          response: followUpResult.response.text(),
          history: await chat.getHistory()
        });
      } else {
        console.warn(`Função ${call.name} solicitada pela IA mas não encontrada localmente.`);

        const fallbackResult = await chat.sendMessage({
          functionResponse: {
            name: call.name,
            response: { error: `Function ${call.name} not implemented or found.` }
          }
        });

        return res.json({
          response: fallbackResult.response.text(),
          history: await chat.getHistory()
        });
      }
    }

    console.log("Resposta do Gemini (sem chamada de função):", geminiResponse.text());

    res.json({
      response: geminiResponse.text(),
      history: await chat.getHistory()
    });

  } catch (error) {
    console.error("Erro no endpoint /chat:", error);
    
    if (error.message && error.message.includes("API key not valid")) {
      res.status(401).json({ error: "Chave de API do Gemini inválida ou não configurada corretamente." });
    } else if (error.message && error.message.toUpperCase().includes("SAFETY")) {
      res.status(400).json({ error: "A resposta foi bloqueada devido às configurações de segurança. Tente uma pergunta diferente." });
    } else if (error.response && error.response.promptFeedback && error.response.promptFeedback.blockReason) {
      res.status(400).json({ error: `A resposta foi bloqueada: ${error.response.promptFeedback.blockReason}` });
    } else {
      res.status(500).json({ error: "Ocorreu um erro interno no servidor.", details: error.message });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));
