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

// ---------------------------------------------------------------------------
// Per-domain CSS selector config.
// NOTE: Flipkart / Myntra / Ajio / Nykaa / Meesho / Croma are heavy JS SPAs.
// Their raw server HTML often won't contain populated <img src> tags because
// content is injected client-side after React hydration. The selectors below
// are a best-effort bonus layer — the real workhorses for these sites are
// the JSON-LD and og:image extractors that run BEFORE this layer.
// If a site returns few/no images, that's expected; you'd need a headless
// browser (Playwright/Puppeteer) to render JS for guaranteed results there.
// ---------------------------------------------------------------------------
const SITE_SELECTORS = [
    {
        match: (host) => host.includes("amazon."),
        mainImage: "#landingImage, #imgBlkFront, #main-image",
        mainImageAttrs: ["data-old-hires", "src"],
        gallery: "#altImages img, #imageBlock img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("flipkart.com"),
        mainImage: "img._396cs4, img._2r_T1I, img._53J4C-",
        mainImageAttrs: ["src"],
        gallery: "div._3kidJX img, li._20Gt85 img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("myntra.com"),
        mainImage: "div.image-grid-image",
        mainImageAttrs: ["style"], // background-image:url(...) — parsed specially below
        gallery: "div.image-grid-image",
        galleryAttrs: ["style"]
    },
    {
        match: (host) => host.includes("ajio.com"),
        mainImage: "div.rilrtl-lazy-img img, picture img",
        mainImageAttrs: ["src", "data-src"],
        gallery: "div.rilrtl-lazy-img img",
        galleryAttrs: ["src", "data-src"]
    },
    {
        match: (host) => host.includes("nykaa.com"),
        mainImage: "img.css-xrsniz, div.product-image img",
        mainImageAttrs: ["src"],
        gallery: "div.product-thumbnail img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("meesho.com"),
        mainImage: "img[data-testid='product-image'], img.sc-eDvSVe",
        mainImageAttrs: ["src", "data-src"],
        gallery: "div.ProductImageCarousel img",
        galleryAttrs: ["src", "data-src"]
    },
    {
        match: (host) => host.includes("snapdeal.com"),
        mainImage: "img#bx-slider-thumb, div.cloudzoom img",
        mainImageAttrs: ["src", "data-zoom-image"],
        gallery: "div.bx-slider img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("croma.com"),
        mainImage: "img.pdp-image, div.product-image img",
        mainImageAttrs: ["src"],
        gallery: "div.thumb-container img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("reliancedigital.in"),
        mainImage: "img.pdp__image, img.product-image",
        mainImageAttrs: ["src"],
        gallery: "div.thumbnails img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("tatacliq.com"),
        mainImage: "img.ProductImages, div.pdp-main-image img",
        mainImageAttrs: ["src"],
        gallery: "div.pdp-thumbnail img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("ebay.com"),
        mainImage: "img#icImg",
        mainImageAttrs: ["src"],
        gallery: "div.ux-image-carousel img, div.ux-image-grid img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("etsy.com"),
        mainImage: "div.listing-page-image img, img[data-index]",
        mainImageAttrs: ["src"],
        gallery: "ul.carousel-pane-list img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("aliexpress.com"),
        mainImage: "img.magnifier-image, div.image-view img",
        mainImageAttrs: ["src"],
        gallery: "div.slider--img--RCpaB img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("bestbuy.com"),
        mainImage: "img.primary-image",
        mainImageAttrs: ["src"],
        gallery: "ul.thumbnail-list img",
        galleryAttrs: ["src"]
    },
    {
        match: (host) => host.includes("walmart.com"),
        mainImage: "img[data-testid='hero-image']",
        mainImageAttrs: ["src"],
        gallery: "div.thumbnail-strip img",
        galleryAttrs: ["src"]
    }
];

function getSiteConfig(hostname) {
    return SITE_SELECTORS.find((cfg) => cfg.match(hostname));
}

function extractBgUrl(styleAttr) {
    if (!styleAttr) return null;
    const m = styleAttr.match(/url\((['"]?)(.*?)\1\)/);
    return m ? m[2] : null;
}

function pickAttr($el, attrs) {
    for (const attr of attrs) {
        const val = $el.attr(attr);
        if (val && !val.startsWith("data:image")) return val;
    }
    return null;
}

// -------------------- Layer 1: JSON-LD Product schema --------------------
function extractFromJsonLd($) {
    const found = [];
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).contents().text();
            if (!raw) return;
            let parsed = JSON.parse(raw);
            const items = Array.isArray(parsed) ? parsed : [parsed];
            items.forEach((item) => {
                const graph = item["@graph"] ? item["@graph"] : [item];
                graph.forEach((node) => {
                    if (!node || typeof node !== "object") return;
                    const type = node["@type"];
                    const isProduct = type === "Product" || (Array.isArray(type) && type.includes("Product"));
                    if (!isProduct || !node.image) return;
                    const imgs = Array.isArray(node.image) ? node.image : [node.image];
                    imgs.forEach((img) => {
                        if (typeof img === "string") found.push(img);
                        else if (img && img.url) found.push(img.url);
                    });
                });
            });
        } catch (_) {
            // malformed JSON-LD, skip
        }
    });
    return found;
}

// -------------------- Layer 2: og:image / twitter:image --------------------
function extractFromMeta($) {
    const getMeta = (property) =>
        $(`meta[property="${property}"]`).attr("content") ||
        $(`meta[name="${property}"]`).attr("content") || "";
    const found = [];
    ["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"].forEach((prop) => {
        const val = getMeta(prop);
        if (val) found.push(val);
    });
    return found;
}

// -------------------- Layer 3: site-specific CSS selectors --------------------
function extractFromSiteSelectors($, hostname) {
    const cfg = getSiteConfig(hostname);
    if (!cfg) return [];
    const found = [];

    $(cfg.mainImage).each((_, el) => {
        const $el = $(el);
        let val;
        if (cfg.mainImageAttrs.includes("style")) {
            val = extractBgUrl($el.attr("style"));
        } else {
            val = pickAttr($el, cfg.mainImageAttrs);
        }
        if (val) found.push(val);
    });

    $(cfg.gallery).each((_, el) => {
        const $el = $(el);
        let val;
        if (cfg.galleryAttrs.includes("style")) {
            val = extractBgUrl($el.attr("style"));
        } else {
            val = pickAttr($el, cfg.galleryAttrs);
        }
        if (val) found.push(val);
    });

    return found;
}

// -------------------- Layer 4: generic fallback (any <img> above a size hint) --------------------
function extractGenericFallback($) {
    const found = [];
    $("img").each((_, el) => {
        const $el = $(el);
        const src = pickAttr($el, ["src", "data-src", "data-lazy-src"]);
        if (!src) return;
        // Skip obvious icons/sprites/tracking pixels
        if (/sprite|icon|pixel|logo|1x1|blank\.gif/i.test(src)) return;
        found.push(src);
    });
    return found;
}

function extractAllImages($, hostname) {
    let images = new Set();

    extractFromJsonLd($).forEach((u) => images.add(u));
    if (images.size === 0) extractFromMeta($).forEach((u) => images.add(u));
    else extractFromMeta($).forEach((u) => images.add(u)); // still add meta as extra candidates

    extractFromSiteSelectors($, hostname).forEach((u) => images.add(u));

    // Only fall back to the generic scrape if we still have nothing —
    // it's noisy and can pull in unrelated page images.
    if (images.size === 0) {
        extractGenericFallback($).forEach((u) => images.add(u));
    }

    return images;
}

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
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

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

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    let urlToScrape;
    if (req.method === "GET") {
        urlToScrape = req.query?.url;
        if (!urlToScrape) {
            try {
                const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
                urlToScrape = parsedUrl.searchParams.get("url");
            } catch (e) {}
        }

        if (!urlToScrape) {
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
        .warn { background: #fff3cd; color: #856404; padding: 12px 15px; border-radius: 6px; margin-top: 20px; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <h1>Product Extractor API</h1>
        <p>Extracts product images from Amazon, Flipkart, Myntra, Ajio, Nykaa, Meesho, Snapdeal, Croma, Reliance Digital, TataCliq, eBay, Etsy, AliExpress, Best Buy, Walmart, and generic sites.</p>

        <div class="endpoint">GET /?url=...</div>
        <div class="endpoint">POST /</div>

        <h3>GET Example</h3>
        <pre><code>GET /?url=https://www.amazon.in/dp/B0CHX1W1XY</code></pre>

        <h3>POST Request Body (JSON)</h3>
        <pre><code>{
  "url": "https://www.amazon.in/dp/B0CHX1W1XY"
}</code></pre>

        <h3>Success Response (200 OK)</h3>
        <pre><code>{
  "success": true,
  "images": ["https://..."],
  "source": "jsonld | meta | selector | generic"
}</code></pre>

        <div class="warn">
        <strong>Heads up:</strong> Flipkart, Myntra, Ajio, Nykaa, Meesho and Croma render products via JavaScript.
        This scraper only fetches static HTML, so results for those sites depend on JSON-LD / meta tags being present —
        it won't always get every gallery image. For guaranteed results there, use a headless browser (Playwright/Puppeteer).
        </div>
    </div>
</body>
</html>`;
            res.setHeader("Content-Type", "text/html");
            return res.status(200).send ? res.status(200).send(docHTML) : res.status(200).end(docHTML);
        }
    } else if (req.method === "POST") {
        urlToScrape = req.body?.url;
    } else {
        return res.status(405).json({ success: false, message: "Method Not Allowed. Use GET or POST." });
    }

    if (!urlToScrape) {
        return res.status(400).json({ success: false, message: "URL parameter is required." });
    }

    let url = urlToScrape.trim();

    if (!isValidUrl(url)) {
        return res.status(400).json({ success: false, message: "Invalid URL format." });
    }

    const cachedData = cache.get(url);
    if (cachedData) {
        return res.status(200).json({ success: true, images: cachedData, cached: true });
    }

    try {
        const randomUserAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
        const hostname = new URL(url).hostname.replace(/^www\./, "");

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
        const imageSet = extractAllImages($, hostname);

        const finalImages = Array.from(imageSet)
            .map((imgUrl) => {
                try {
                    return new URL(imgUrl, url).href;
                } catch (e) {
                    return null;
                }
            })
            .filter(Boolean)
            .slice(0, 15);

        cache.set(url, finalImages);

        return res.status(200).json({
            success: true,
            images: finalImages,
            count: finalImages.length
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

    app.use(helmet());

    const limiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 100,
        message: { success: false, message: "Too many requests, please try again later." }
    });
    app.use("/", limiter);

    app.use(express.json());

    app.all("/", module.exports);

    app.listen(PORT, () => {
        console.log(`Server running at:\nhttp://localhost:${PORT}`);
    });
}
