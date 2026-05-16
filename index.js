const express = require('express');
const puppeteer = require('puppeteer'); // Usando puppeteer estándar
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware manual blindado para tumbar el bloqueo de CORS (Preflight OPTIONS)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    // Si el navegador pregunta antes de enviar los datos (Preflight), respondemos OK directo
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

// Inicialización de Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

app.post('/api/scan', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new", 
            args: [
                '--disable-blink-features=AutomationControlled',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Evita saturación de RAM en Railway
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-extensions',
                '--window-size=1920,1080' // Forzamos tamaño de monitor estándar para simular pantalla real
            ]
        });

        const page = await browser.newPage();
        
        // Forzamos un viewport real coincidente con la ventana simulada
        await page.setViewport({ width: 1920, height: 1080 });
        
        // User Agent común y corriente de una máquina de escritorio estable
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        // Cabeceras extra para imitar un sistema operativo en español
        await page.setExtraHTTPHeaders({
            'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
            'upgrade-insecure-requests': '1'
        });

        // Optimización: Bloqueamos imágenes para que cargue volando
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // 2. Navegar a la URL cambiando 'networkidle2' por 'domcontentloaded'
        // Esto evita quedarse esperando eternamente a que carguen scripts publicitarios o de rastreo de Amazon
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Pausa táctica de 2 segundos para dejar que el HTML estructural se asiente antes de raspar
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 3. Extraer datos (Aumentamos a los primeros 3000 caracteres de texto para pescar más specs)
        const pageData = await page.evaluate(() => {
            const title = document.querySelector('h1')?.innerText || document.title || "";
            const body = document.body.innerText.substring(0, 3000);
            return `PRODUCT TITLE: ${title} \n CONTENT: ${body}`;
        });

        await browser.close();

        // 4. Prompt optimizado en inglés para Gemini 3
        const prompt = `
            Extract technical hardware data from the following text provided by a hardware store.
            
            Instructions:
            1. Identify if the product is a "gpu" or a "cpu".
            2. Extract the full commercial name of the model.
            3. Identify the TDP (Thermal Design Power) in Watts.
            4. If TDP is missing, provide a realistic estimate for this specific model.
            
            Response Format (Strict JSON only):
            {
                "type": "gpu" | "cpu",
                "name": "Full Model Name",
                "tdp": number
            }

            Text to analyze:
            ${pageData}
        `;

        // 5. Llamada a la IA y limpieza de respuesta
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let rawText = response.text().trim();
        
        rawText = rawText.replace(/```json|```/g, "").trim();

        const start = rawText.indexOf('{');
        const end = rawText.lastIndexOf('}');
        
        if (start !== -1 && end !== -1) {
            const cleanJson = rawText.substring(start, end + 1);
            const data = JSON.parse(cleanJson);
            res.json(data);
        } else {
            throw new Error("La IA no devolvió un formato JSON válido.");
        }

    } catch (error) {
        if (browser) await browser.close();
        console.error("Error en el servidor:", error.message);
        res.status(500).json({ 
            error: 'Error al procesar el componente', 
            detail: error.message 
        });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));