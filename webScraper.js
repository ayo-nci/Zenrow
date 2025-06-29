require('dotenv').config({ path: '.env' });
const fs = require('fs');
const axios = require('axios');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const path = require('path');

// Only execute this code in the main thread
if (isMainThread) {
    // Main thread code
    const { ZENROWS_API_KEY } = process.env;
    
    if (!ZENROWS_API_KEY) {
        console.error('ZENROWS_API_KEY is not defined in .env file');
        process.exit(1);
    }
    
    // Add your search term here
    const searchString = "smartphone";
    
    // Create output directory if it doesn't exist
    const outputDir = path.join(__dirname, 'scraped_data');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        console.log(`Created directory: ${outputDir}`);
    }
    
    // Define the URLs to scrape
    const urlsToScrape = [
        {
            url: `https://www.jumia.com.ng/catalog/?q=${encodeURIComponent(searchString)}`,
            site: 'jumia',
            outputFile: path.join(outputDir, `jumia_${searchString}_${Date.now()}.json`)
        },
        {
            url: `https://www.konga.com/search?search=${encodeURIComponent(searchString)}`,
            site: 'konga',
            outputFile: path.join(outputDir, `konga_${searchString}_${Date.now()}.json`)
        }
    ];
    
    // Function to create a worker for each URL
    const createWorker = (urlData) => {
        return new Promise((resolve, reject) => {
            // Pass the API key and URL data to the worker
            const worker = new Worker(__filename, { 
                workerData: {
                    apiKey: ZENROWS_API_KEY,
                    urlData: urlData,
                    searchString: searchString
                }
            });
            
            worker.on('message', (message) => {
                console.log(message);
                resolve();
            });
            
            worker.on('error', (error) => {
                console.error(`Worker error for ${urlData.site}:`, error);
                reject(error);
            });
            
            worker.on('exit', (code) => {
                if (code !== 0) {
                    const error = new Error(`Worker for ${urlData.site} stopped with exit code ${code}`);
                    console.error(error.message);
                    reject(error);
                }
            });
        });
    };
    
    // Start all workers in parallel
    const runAllWorkers = async () => {
        console.log('Starting scraping workers...');
        
        const workerPromises = urlsToScrape.map(urlData => createWorker(urlData));
        
        try {
            await Promise.all(workerPromises);
            console.log('All scraping tasks completed.');
            
            // Optionally combine all results into a single file
            const combineResults = true;
            
            if (combineResults) {
                const allResults = [];
                
                for (const urlData of urlsToScrape) {
                    try {
                        if (fs.existsSync(urlData.outputFile)) {
                            const fileData = fs.readFileSync(urlData.outputFile, 'utf8');
                            const parsedData = JSON.parse(fileData);
                            allResults.push(parsedData);
                        }
                    } catch (err) {
                        console.error(`Error reading ${urlData.outputFile}:`, err.message);
                    }
                }
                
                if (allResults.length > 0) {
                    const combinedFile = path.join(outputDir, `combined_results_${searchString}_${Date.now()}.json`);
                    fs.writeFileSync(combinedFile, JSON.stringify(allResults, null, 2));
                    console.log(`Combined results saved to ${combinedFile}`);
                }
            }
        } catch (error) {
            console.error('Error running workers:', error);
        }
    };
    
    // Execute all workers
    runAllWorkers();
    
} else {
    // Worker thread code - runs in separate threads
    const { apiKey, urlData, searchString } = workerData;
    
    // Function to scrape a URL
    const scrapeUrl = async () => {
        try {
            parentPort.postMessage(`Worker started for ${urlData.site}`);
            let jumiaCssExtractor = {'premiumItems': "[data-catalog='true']"};
            const response = await axios({
                url: 'https://api.zenrows.com/v1/',
                method: 'GET',
                params: {
                    'url': urlData.url,
                    'apikey': apiKey,
                    'wait': '15000',
                    'js_render': 'true',
                  //  'response_type': 'markdown',
                  //  'autoparse': 'true',
                   'original_status': true,
                   'allowed_status_codes': '400,500,503',
                    'css_extractor': jumiaCssExtractor,
                  //  ...(urlData.site === 'jumia' ? { 'css_extractor': jumiaCssExtractor } : {}),
                    // Adding site-specific parameters if needed
                  //  ...(urlData.site === 'jumia' ? { 'wait_for': '[data-catalog="true"]' } : {}),
                  //  ...(urlData.site === 'jumia' ? { 'wait_for': '.core' } : {}),
                  //  ...(urlData.site === 'konga' ? { 'wait_for': '.product-block' } : {})
                }
            });
            
            if (response.status === 200) {
                parentPort.postMessage(`Successfully scraped ${urlData.site}`);
                
                const result = {
                    source: urlData.site,
                    searchTerm: searchString,
                    timestamp: new Date().toISOString(),
                    data: response.data
                };
                
                // Save to individual file
                fs.writeFileSync(urlData.outputFile, JSON.stringify(result, null, 2));
                parentPort.postMessage(`Data for ${urlData.site} saved to ${urlData.outputFile}`);
                
                return true;
            } else {
                parentPort.postMessage(`Error: Received status code ${response.status} for ${urlData.site}`);
                return false;
            }
        } catch (error) {
            parentPort.postMessage(`Error scraping ${urlData.site}: ${error.message}`);
            
            // Save error information
            const errorResult = {
                source: urlData.site,
                searchTerm: searchString,
                timestamp: new Date().toISOString(),
                error: {
                    message: error.message,
                    code: error.code
                }
            };
            
            fs.writeFileSync(urlData.outputFile, JSON.stringify(errorResult, null, 2));
            parentPort.postMessage(`Error data for ${urlData.site} saved to ${urlData.outputFile}`);
            
            return false;
        }
    };
    
    // Execute scraping in the worker
    scrapeUrl()
        .then(() => {
            parentPort.postMessage(`Worker for ${urlData.site} completed`);
        })
        .catch(error => {
            parentPort.postMessage(`Worker for ${urlData.site} failed: ${error.message}`);
        });
}