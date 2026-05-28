const express = require('express');
const puppeteer = require('puppeteer'); 
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cors = require('cors');
require('dotenv').config();

const app = express();

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
    model: "gemini-3.5-flash", 
    generationConfig: { responseMimeType: "application/json" } 
});

app.post('/api/scan', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL requerida' });

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: "new", 
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled', 
                '--disable-infobars',
                '--window-size=1920,1080',
                '--disable-dev-shm-usage', 
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-extensions',
                '--disable-gpu'
            ]
        });

        const page = await browser.newPage();
        
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', {
                get: () => undefined,
            });
        });

        await page.setViewport({ width: 1920, height: 1080 });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        await page.setExtraHTTPHeaders({
            'accept-language': 'es-ES,es;q=0.9,en;q=0.8',
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'upgrade-insecure-requests': '1'
        });

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 400; 
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= 2500 || totalHeight >= scrollHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 150); 
            });
        });

        await new Promise(resolve => setTimeout(resolve, 2000));

        const pageData = await page.evaluate(() => {
            const title = document.querySelector('h1')?.innerText || document.title || "";
            const fichaTecnica = document.querySelector('#ficha-tecnica')?.innerText || "";
            const caracteristicas = document.querySelector('.js-article-specs')?.innerText || "";
            const tablas = Array.from(document.querySelectorAll('table')).map(t => t.innerText).join(' ');
            const bodyText = document.body.innerText.substring(0, 6000);
            
            return `PRODUCT TITLE: ${title} \n SPECS VIA SELECTORS: ${fichaTecnica} ${caracteristicas} \n TABLES CONTENT: ${tablas} \n GENERAL BODY TEXT: ${bodyText}`;
        });

        await browser.close();
        browser = null;

        // PROMPT FIX: Forzado estricto de coincidencia literal para evitar alucinaciones semánticas de tipo
        const prompt = `
            Analyze the following extracted text from a hardware store page. 
            Your goal is to extract the hardware technical specifications into a strict JSON format.

            CRITICAL RAM EXTRACTION RULES:
            1. "ramGB": Extract the total system memory capacity as a number (e.g., "2GB" or "2 GB" -> 2).
            2. "ramModulesCount": Count the number of physical memory modules. If it is a single retail module sale layout, set strictly to 1.
            3. "ramType": Identify the exact memory generation string (e.g., "ddr", "ddr2", "ddr3", "ddr4", "ddr5").
               - YOU MUST LOOK AT THE "PRODUCT TITLE" AND "LO MÁS DESTACADO" FIELDS WITH 200% MAXIMUM PRIORITY.
               - IF THE RAW TEXT EXPLICITLY STATES "DDR2", THE VALUE MUST BE ABSOLUTELY "ddr2".
               - NEVER upgrade or guess the hardware generation based on your training trends or external assumptions. Avoid hallucination. If it says DDR2, it is DDR2.

            STORAGE EXTRACTION RULES:
            1. "storageDrives": Extract physical storage specifications using exactly one of these match keys:
               - "nvme_gen5" (if text mentions Gen5, PCIe 5.0)
               - "nvme_gen4" (if text mentions Gen4, PCIe 4.0)
               - "nvme" (standard M.2 NVMe, PCIe 3.0)
               - "sata_ssd" (2.5" SSD, SATA III)
               - "hdd" (Mechanical hard drive, 3.5")

            COMPONENTS ARRAY RULE:
            1. If the scanned link is an individual piece of RAM or a single standalone SSD/HDD drive, leave the "components" array completely empty: []. Only fill "components" if there is an explicit GPU, CPU, Monitor or Peripherals package included.

            CRITICAL ACCURACY INSTRUCTIONS:
            - Ignore items listed under "sponsored", "frequently bought together", or related component ads unless explicitly included inside the retail package.
            - Read the product information literally. Do not upgrade hardware generations under any circumstances.

            Response Format (Strict JSON format only):
            {
                "isPrebuilt": true | false,
                "ramGB": number,
                "ramModulesCount": number,
                "ramType": string,
                "storageDrives": [
                    {
                        "sizeGB": number,
                        "interface": "nvme_gen5" | "nvme_gen4" | "nvme" | "sata_ssd" | "hdd"
                    }
                ],
                "components": [
                    {
                        "type": "gpu" | "cpu" | "monitor" | "periferico",
                        "name": "Full Model Name (e.g. RTX 4070 / Ryzen 7 7800X3D)",
                        "tdp": number
                    }
                ]
            }

            Text to analyze:
            ${pageData}
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const rawText = response.text().trim();
        
        const data = JSON.parse(rawText);
        res.json(data);

    } catch (error) {
        console.error("Error en el servidor:", error.message);
        res.status(500).json({ 
            error: 'Error al procesar el componente', 
            detail: error.message 
        });
    } finally {
        if (browser !== null) {
            await browser.close();
        }
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));