require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Create directory for scraped data
const outputDir = path.join(__dirname, 'scraped_data');
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`Created directory: ${outputDir}`);
}

// Cache for search results to reduce API calls
const searchCache = new Map();
const CACHE_EXPIRATION = 30 * 60 * 1000; // 30 minutes

// Search API endpoint
app.get('/api/search', async (req, res) => {
    try {
        const searchTerm = req.query.term;
        
        if (!searchTerm || searchTerm.trim() === '') {
            return res.status(400).json({ error: 'Search term is required' });
        }
        
        // Check if valid results exist in cache
        const cacheKey = searchTerm.toLowerCase().trim();
        if (searchCache.has(cacheKey)) {
            const cachedData = searchCache.get(cacheKey);
            const cacheAge = Date.now() - cachedData.timestamp;
            
            // Return cached results if they're still fresh
            if (cacheAge < CACHE_EXPIRATION) {
                console.log(`Returning cached results for "${searchTerm}"`);
                return res.json(cachedData.results);
            }
        }
        
        // Check for API key
        const { ZENROWS_API_KEY } = process.env;
        if (!ZENROWS_API_KEY) {
            return res.status(500).json({ error: 'ZenRows API key is not configured' });
        }
        
        console.log(`Searching for "${searchTerm}" on Jumia and Konga`);
        
        // Define the URLs to scrape
        const urlsToScrape = [
            {
                url: `https://www.jumia.com.ng/catalog/?q=${encodeURIComponent(searchTerm)}`,
                site: 'jumia',
                outputFile: path.join(outputDir, `jumia_${searchTerm}_${Date.now()}.json`)
            },
            {
                url: `https://www.konga.com/search?search=${encodeURIComponent(searchTerm)}`,
                site: 'konga',
                outputFile: path.join(outputDir, `konga_${searchTerm}_${Date.now()}.json`)
            }
        ];
        
        // Start the scraping with worker threads
        const rawResults = await runScrapers(urlsToScrape, searchTerm, ZENROWS_API_KEY);
        
        // Process the raw results to extract product information
        const processedResults = rawResults.map(result => {
            const processedResult = {
                source: result.source,
                searchTerm: result.searchTerm,
                timestamp: result.timestamp,
                products: []
            };
            
            if (result.error) {
                return processedResult;
            }
            
            try {
                if (result.source === 'jumia') {
                    processedResult.products = extractJumiaProducts(result.data);
                } else if (result.source === 'konga') {
                    processedResult.products = extractKongaProducts(result.data);
                }
            } catch (error) {
                console.error(`Error processing ${result.source} data:`, error);
            }
            
            return processedResult;
        });
        
        // Store in cache
        searchCache.set(cacheKey, {
            timestamp: Date.now(),
            results: processedResults
        });
        
        // Return the results
        res.json(processedResults);
        
    } catch (error) {
        console.error('Error handling search request:', error);
        res.status(500).json({ error: 'An error occurred during search' });
    }
});

// Function to extract product information from Jumia data
function extractJumiaProducts(data) {
    const products = [];
    
    try {
        // Find product names and details in the Jumia data
        const productData = Array.isArray(data) ? data : [data];
        
        for (const item of productData) {
            // Process each item to find product information
            if (item && typeof item === 'object') {
                // Look for product name
                if (item.name && typeof item.name === 'string' && !item.name.includes('CTA') && !item.name.includes('adUnitPath')) {
                    // This appears to be a product
                    const product = {
                        name: item.name,
                        brand: item.brandKey || item.categoryKey || '',
                        price: '',
                        originalPrice: null,
                        discount: null,
                        url: item.url || '',
                        image: null
                    };
                    
                    // Try to find price information
                    if (item.lowPriceFormatted) {
                        product.price = item.lowPriceFormatted;
                    }
                    
                    // Add to products array if it seems to be a product
                    if (product.name && !products.some(p => p.name === product.name)) {
                        products.push(product);
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error extracting Jumia products:', error);
    }
    
    return products;
}

// Function to extract product information from Konga data
function extractKongaProducts(data) {
    const products = [];
    
    try {
        // Find product information in the Konga data
        if (Array.isArray(data) && data.length > 0) {
            // Process first item which contains the product data
            const firstItem = data[0];
            
            if (firstItem && firstItem.props && firstItem.props.initialState) {
                const state = firstItem.props.initialState;
                
                // Check if there are search results
                if (state.search && state.search.query === 'smartphone') {
                    // Try to extract products from hits
                    const hits = state.search.hits || [];
                    
                    hits.forEach(hit => {
                        if (hit && hit.name) {
                            const product = {
                                name: hit.name,
                                brand: hit.brand || '',
                                price: formatPrice(hit.special_price || hit.price),
                                originalPrice: hit.special_price ? formatPrice(hit.price) : null,
                                discount: hit.special_price ? calculateDiscount(hit.price, hit.special_price) : null,
                                url: `https://www.konga.com/product/${hit.url_key}`,
                                image: hit.image_thumbnail_path ? `https://www-konga-com-res.cloudinary.com/w_auto,f_auto,fl_lossy,dpr_auto,q_auto/media/catalog/product${hit.image_thumbnail_path}` : null
                            };
                            
                            products.push(product);
                        }
                    });
                }
            }
        }
    } catch (error) {
        console.error('Error extracting Konga products:', error);
    }
    
    return products;
}

// Helper function to format price
function formatPrice(price) {
    if (!price) return '';
    return `₦${Number(price).toLocaleString()}`;
}

// Helper function to calculate discount percentage
function calculateDiscount(originalPrice, discountedPrice) {
    if (!originalPrice || !discountedPrice) return null;
    const discount = ((originalPrice - discountedPrice) / originalPrice) * 100;
    return `-${Math.round(discount)}%`;
}

// Function to run scrapers using worker threads
function runScrapers(urlsToScrape, searchTerm, apiKey) {
    return new Promise((resolve, reject) => {
        const results = [];
        let completedWorkers = 0;
        
        for (const urlData of urlsToScrape) {
            // Create worker for each URL
            const worker = new Worker(__filename, {
                workerData: {
                    apiKey: apiKey,
                    urlData: urlData,
                    searchTerm: searchTerm
                }
            });
            
            worker.on('message', (message) => {
                if (message.type === 'result') {
                    results.push(message.data);
                }
                console.log(message.log);
            });
            
            worker.on('error', (error) => {
                console.error(`Worker error for ${urlData.site}:`, error);
            });
            
            worker.on('exit', (code) => {
                completedWorkers++;
                
                if (completedWorkers === urlsToScrape.length) {
                    resolve(results);
                }
            });
        }
    });
}

// Worker thread code
if (!isMainThread) {
    const { apiKey, urlData, searchTerm } = workerData;
    
    // Function to scrape a URL
    async function scrapeUrl() {
        try {
            parentPort.postMessage({ type: 'log', log: `Worker started for ${urlData.site}` });
            
            const response = await axios({
                url: 'https://api.zenrows.com/v1/',
                method: 'GET',
                params: {
                    'url': urlData.url,
                    'apikey': apiKey,
                    'wait': '5000',
                    'autoparse': 'true',
                 //   'js_render': 'true',
                 //   'json_response': 'true',
                    // Adding site-specific parameters if needed
                //    ...(urlData.site === 'jumia' ? { 'wait_for': '.core' } : {}),
                 //   ...(urlData.site === 'konga' ? { 'wait_for': '.product-block' } : {})
                }
            });
            
            if (response.status === 200) {
                parentPort.postMessage({ type: 'log', log: `Successfully scraped ${urlData.site}` });
                
                const result = {
                    source: urlData.site,
                    searchTerm: searchTerm,
                    timestamp: new Date().toISOString(),
                    data: response.data
                };

                let _result = response.data;
                
                // Save to individual file
                fs.writeFileSync(urlData.outputFile, JSON.stringify(result, null, 2));
                parentPort.postMessage({ 
                    type: 'log', 
                    log: `Data for ${urlData.site} saved to ${urlData.outputFile}` 
                });
                
                // Send result back to main thread
                parentPort.postMessage({ type: 'result', data: _result});
                
                return true;
            } else {
                parentPort.postMessage({ 
                    type: 'log', 
                    log: `Error: Received status code ${response.status} for ${urlData.site}` 
                });
                
                const errorResult = {
                    source: urlData.site,
                    searchTerm: searchTerm,
                    timestamp: new Date().toISOString(),
                    error: `Status code: ${response.status}`
                };
                
                parentPort.postMessage({ type: 'result', data: errorResult });
                
                return false;
            }
        } catch (error) {
            parentPort.postMessage({ 
                type: 'log', 
                log: `Error scraping ${urlData.site}: ${error.message}` 
            });
            
            // Send error result
            const errorResult = {
                source: urlData.site,
                searchTerm: searchTerm,
                timestamp: new Date().toISOString(),
                error: {
                    message: error.message,
                    code: error.code
                }
            };
            
            parentPort.postMessage({ type: 'result', data: errorResult });
            
            return false;
        }
    }
    
    // Execute scraping in the worker
    scrapeUrl()
        .then(() => {
            parentPort.postMessage({ type: 'log', log: `Worker for ${urlData.site} completed` });
        })
        .catch(error => {
            parentPort.postMessage({ 
                type: 'log', 
                log: `Worker for ${urlData.site} failed: ${error.message}` 
            });
        });
} else {
    // Start server only in main thread
    app.listen(PORT, () => {
        console.log(`E-commerce comparison server running on port ${PORT}`);
        console.log(`Access the API at http://localhost:${PORT}/api/search?term=smartphone`);
    });
}