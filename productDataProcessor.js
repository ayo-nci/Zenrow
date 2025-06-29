// productDataProcessor.js
// This utility processes the raw scraped data from Jumia and Konga
// and extracts structured product information

/**
 * Processes raw JSON data from both Jumia and Konga
 * @param {Object} jumiaData - Raw JSON data from Jumia
 * @param {Object} kongaData - Raw JSON data from Konga
 * @returns {Object} - Processed data with extracted products
 */
function processScrapedData(jumiaData, kongaData) {
    return {
        jumia: processJumiaData(jumiaData),
        konga: processKongaData(kongaData)
    };
}

/**
 * Processes raw Jumia data to extract product information
 * @param {Object} data - Raw JSON data from Jumia
 * @returns {Object} - Processed data with product list
 */
function processJumiaData(data) {
    const result = {
        source: 'jumia',
        searchTerm: data.searchTerm || '',
        timestamp: data.timestamp || new Date().toISOString(),
        products: []
    };
    
    try {
        if (!data.data || !Array.isArray(data.data)) {
            console.error('Invalid Jumia data structure');
            return result;
        }
        
        // Extract product information from the data array
        const products = [];
        const skus = [];
        const names = [];
        const prices = [];
        const discounts = [];
        const brands = [];
        const urls = [];
        
        // First pass - collect product SKUs, names, etc.
        data.data.forEach(item => {
            // Extract SKUs array
            if (item.skus && Array.isArray(item.skus)) {
                skus.push(...item.skus);
            }
            
            // Extract product names
            if (item.name && typeof item.name === 'string' && 
                !item.name.includes('CTA') && 
                !item.name.includes('adUnitPath') &&
                !item.name.includes('FDYJE')) {
                names.push({
                    name: item.name,
                    brand: item.brandKey || '',
                    category: item.categoryKey || ''
                });
            }
            
            // Extract URLs
            if (item.url && typeof item.url === 'string' && item.url.startsWith('/')) {
                urls.push(item.url);
            }
            
            // Extract price information
            if (item.lowPriceFormatted) {
                prices.push({
                    price: item.lowPriceFormatted,
                    otherOffers: item.otherOffers || 0
                });
            }
            
            // Extract discount information
            if (item.discount) {
                discounts.push(item.discount);
            }
        });
        
        // Match names with prices
        let priceIndex = 0;
        names.forEach((nameInfo, index) => {
            if (index < 20) { // Limit to first 20 products
                const product = {
                    name: nameInfo.name,
                    brand: nameInfo.brand || nameInfo.category || '',
                    price: prices[priceIndex] ? prices[priceIndex].price : '',
                    originalPrice: null, // Not always available
                    discount: null, // Not always available
                    url: `https://www.jumia.com.ng/${nameInfo.name.toLowerCase().replace(/[^\w]+/g, '-')}-${skus[index] || ''}`,
                    image: null // Not available in this data structure
                };
                
                // Only add if it seems to be a valid product
                if (product.name && product.name.length > 5) {
                    result.products.push(product);
                }
                
                priceIndex++;
            }
        });
    } catch (error) {
        console.error('Error processing Jumia data:', error);
    }
    
    return result;
}

/**
 * Processes raw Konga data to extract product information
 * @param {Object} data - Raw JSON data from Konga
 * @returns {Object} - Processed data with product list
 */
function processKongaData(data) {
    const result = {
        source: 'konga',
        searchTerm: data.searchTerm || '',
        timestamp: data.timestamp || new Date().toISOString(),
        products: []
    };
    
    try {
        // Check if data has the expected structure
        if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
            console.error('Invalid Konga data structure');
            return result;
        }
        
        // Extract product information from the first item (contains main product data)
        const firstItem = data.data[0];
        
        if (firstItem.props && firstItem.props.initialState) {
            const state = firstItem.props.initialState;
            
            // Extract products from search results
            if (state.search && state.search.hits) {
                state.search.hits.forEach(hit => {
                    if (hit && hit.name) {
                        // Create product object
                        const product = {
                            name: hit.name,
                            brand: hit.brand || '',
                            price: formatPrice(hit.special_price || hit.price),
                            originalPrice: hit.special_price ? formatPrice(hit.price) : null,
                            discount: hit.special_price ? calculateDiscount(hit.price, hit.special_price) : null,
                            url: `https://www.konga.com/product/${hit.url_key}`,
                            image: hit.image_thumbnail_path ? 
                                `https://www-konga-com-res.cloudinary.com/w_auto,f_auto,fl_lossy,dpr_auto,q_auto/media/catalog/product${hit.image_thumbnail_path}` : 
                                null
                        };
                        
                        result.products.push(product);
                    }
                });
            }
        }
    } catch (error) {
        console.error('Error processing Konga data:', error);
    }
    
    return result;
}

/**
 * Helper function to format price
 * @param {number|string} price - Raw price value
 * @returns {string} - Formatted price with currency symbol
 */
function formatPrice(price) {
    if (!price) return '';
    return `₦${Number(price).toLocaleString()}`;
}

/**
 * Helper function to calculate discount percentage
 * @param {number} originalPrice - Original price
 * @param {number} discountedPrice - Discounted price
 * @returns {string} - Formatted discount percentage
 */
function calculateDiscount(originalPrice, discountedPrice) {
    if (!originalPrice || !discountedPrice) return null;
    const discount = ((originalPrice - discountedPrice) / originalPrice) * 100;
    return `-${Math.round(discount)}%`;
}

/**
 * Extracts structured product data from raw JSON response
 * @param {string} jsonString - Raw JSON string from scraper
 * @returns {Array} - Array of product objects
 */
function extractProductsFromRawJson(jsonString) {
    try {
        const data = JSON.parse(jsonString);
        
        if (data.source === 'jumia') {
            return processJumiaData(data).products;
        } else if (data.source === 'konga') {
            return processKongaData(data).products;
        } else {
            console.error('Unknown data source');
            return [];
        }
    } catch (error) {
        console.error('Error extracting products from JSON:', error);
        return [];
    }
}

module.exports = {
    processScrapedData,
    processJumiaData,
    processKongaData,
    extractProductsFromRawJson
};