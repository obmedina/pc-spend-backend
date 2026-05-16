const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

async function verModelos() {
    // Es vital que la API KEY se esté cargando
    if (!process.env.GEMINI_API_KEY) {
        console.error("Error: No se encuentra la GEMINI_API_KEY en el .env");
        return;
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    
    try {
        // En versiones recientes, el cliente se obtiene así para listar
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        
        console.log("--- MODELOS DISPONIBLES ---");
        if (data.models) {
            data.models.forEach(m => {
                console.log(`-> ${m.name}`);
            });
        } else {
            console.log("No se devolvieron modelos. Respuesta de Google:", data);
        }
    } catch (e) {
        console.error("Error al conectar:", e.message);
    }
}

verModelos();