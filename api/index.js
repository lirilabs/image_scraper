const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const http = require("http");
const https = require("https");
const NodeCache = require("node-cache");

const cache = new NodeCache({ stdTTL: 3600, checkperiod: 120 }); // 1 hour warm cache
const ipCache = new NodeCache({ stdTTL: 900, checkperiod: 120 }); // 15 mins for Rate Limiting

// Connection Pooling for massive concurrency
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
    "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/115.0"
];

const isValidUrl = (string) => {
    try {
        const parsedUrl = new URL(string);
        return ["http:", "https:"].includes(parsedUrl.protocol);
    } catch (_) {
        return false;
    }
};

// Serverless Handler (Vercel / Node.js standard)
module.exports = async (req, res) => {
    // Enable CORS headers manually for serverless environments
    res.setHeader("Access-Control-Allow-Credentials", true);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
    res.setHeader(
        "Access-Control-Allow-Headers",
        "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );
    // Vercel Edge Caching: Cache on global CDN for 1 hour, serve stale while revalidating
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

    // Security Headers natively for serverless
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

    // IP Rate Limiting Logic
    const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
    const requestCount = ipCache.get(ip) || 0;
    
    if (requestCount >= 50) {
        return res.status(429).json({ success: false, message: "Too many requests from this IP, please try again after 15 minutes." });
    }
    ipCache.set(ip, requestCount + 1);

    // Handle preflight CORS request
    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    if (req.method === "GET") {
        const docHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Product Extractor API</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; background: #f0f2f5; color: #1a1a1a; line-height: 1.6; }
        .container { max-width: 700px; margin: auto; background: white; padding: 40px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.05); }
        h1 { color: #0070f3; margin-top: 0; margin-bottom: 5px; }
        p { color: #555; margin-bottom: 30px; }
        pre { background: #1e1e1e; color: #d4d4d4; padding: 20px; border-radius: 8px; overflow-x: auto; font-size: 14px; }
        code { font-family: monospace; }
        .endpoint { background: #e3f2fd; color: #0d47a1; padding: 10px 15px; border-radius: 6px; font-weight: bold; display: inline-block; margin-bottom: 10px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Product Extractor API</h1>
        <p>A fast, cached, and concurrent API to extract product images from e-commerce URLs like Amazon and Meesho.</p>
        
        <div class="endpoint">POST /</div>
        
        <h3>Request Body (JSON)</h3>
        <pre><code>{
  "url": "https://www.amazon.in/dp/B0CHX1W1XY"
}</code></pre>

        <h3>Success Response (200 OK)</h3>
        <pre><code>{
  "success": true,
  "images": [
    "https://m.media-amazon.com/images/I/71v2jVh6nIL._SX522_.jpg",
    "https://m.media-amazon.com/images/I/516POq-G8+L._SX522_.jpg"
  ]
}</code></pre>
    </div>
</body>
</html>`;
        res.setHeader("Content-Type", "text/html");
        return res.status(200).send ? res.status(200).send(docHTML) : res.status(200).end(docHTML);
    }

    if (req.method !== "POST") {
        return res.status(405).json({ success: false, message: "Method Not Allowed. Use POST for extraction or GET for documentation." });
    }

    let { url } = req.body;

    if (!url) {
        return res.status(400).json({ success: false, message: "URL parameter is required." });
    }

    url = url.trim();

    if (!isValidUrl(url)) {
        return res.status(400).json({ success: false, message: "Invalid URL format." });
    }

    // Check in-memory cache for warm starts
    const cachedData = cache.get(url);
    if (cachedData) {
        return res.status(200).json({ success: true, images: cachedData });
    }

    try {
        const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

        // Kept timeout slightly lower (8s) because serverless functions have execution limits
        const response = await axios.get(url, {
            headers: {
                "User-Agent": randomUserAgent,
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
                "Accept-Encoding": "gzip, deflate, br",
                "Connection": "keep-alive"
            },
            timeout: 8000,
            maxRedirects: 3,
            httpAgent,
            httpsAgent
        });

        const $ = cheerio.load(response.data);
        const getMeta = (property) =>
            $(`meta[property="${property}"]`).attr("content") ||
            $(`meta[name="${property}"]`).attr("content") || "";

        let images = new Set();
        let ogImage = getMeta("og:image") || getMeta("twitter:image");
        if (ogImage) images.add(ogImage);

        // Amazon Image Fallback
        if (url.includes("amazon.") || url.includes("amzn.")) {
            let mainAmzImage = $("#landingImage").attr("src") || $("#imgBlkFront").attr("src") || $("#main-image").attr("src");
            if (mainAmzImage && mainAmzImage.startsWith("data:image")) {
                mainAmzImage = $("#landingImage").attr("data-old-hires") || $("#imgBlkFront").attr("data-old-hires") || mainAmzImage;
            }
            if (mainAmzImage) images.add(mainAmzImage);
            
            // Collect thumbnails
            $("#altImages img, #imageBlock img").each((_, img) => {
                let src = $(img).attr("src");
                if (src && !src.startsWith("data:image") && !src.includes(".gif")) {
                    images.add(src);
                }
            });
        }

        // Generic gathering for all other images on page
        $("img").each((_, img) => {
            let src = $(img).attr("src") || $(img).attr("data-src") || $(img).attr("data-lazy");
            if (src && !src.startsWith("data:image") && !src.includes("svg") && !src.includes("pixel")) {
                images.add(src);
            }
        });

        let finalImages = Array.from(images).map(imgUrl => {
            try {
                return new URL(imgUrl, url).href;
            } catch (e) {
                return imgUrl;
            }
        }).slice(0, 10); // Limit to top 10 images

        // Save to warm cache
        cache.set(url, finalImages);

        return res.status(200).json({
            success: true,
            images: finalImages
        });

    } catch (err) {
        if (err.response) {
            return res.status(err.response.status).json({ success: false, message: `Target failed with status ${err.response.status}` });
        } else if (err.code === "ECONNABORTED") {
            return res.status(504).json({ success: false, message: "Target website timed out." });
        }
        return res.status(500).json({ success: false, message: "Parsing error.", error: err.message });
    }
};

// Local Development Server
if (require.main === module) {
    const express = require("express");
    const helmet = require("helmet");
    const rateLimit = require("express-rate-limit");
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Security headers
    app.use(helmet());

    // Rate Limiting (100 requests per 15 minutes)
    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: { success: false, message: "Too many requests, please try again later." }
    });
    app.use("/", limiter);

    // Parse JSON bodies
    app.use(express.json());

    // Route for the serverless function (exclusively on the root URL)
    app.all("/", module.exports);

    app.listen(PORT, () => {
        console.log(`Server running at:\nhttp://localhost:${PORT}`);
    });
}
