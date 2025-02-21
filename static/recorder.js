// IndexedDB setup
let db;
const DB_NAME = 'audioQueue';
const STORE_NAME = 'chunks';

// Recording state
let recorder;
let isRecording = false;
let chunkCounter = 0;
let mediaStream = null;
let currentStreamId = null;
let networkHealthy = true;
let UPLOAD_ENDPOINT = '/chunk_seperate'; // default endpoint

// Initialize IndexedDB
const initDB = () => {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('streamId', 'streamId', { unique: false });
                store.createIndex('status', 'status', { unique: false });
            }
        };
    });
};

// Queue operations
const addToQueue = async (chunk, streamId, chunkIndex) => {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        
        const item = {
            chunk: chunk,
            streamId: streamId,
            chunkIndex: chunkIndex,
            timestamp: Date.now(),
            status: 'pending',
            retries: 0
        };
        
        const request = store.add(item);
        request.onsuccess = async () => {
            await updateNetworkHealth();
            console.log(`Chunk ${chunkIndex} added to queue`);
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
    });
};

const removeFromQueue = async (id) => {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(id);
        
        request.onsuccess = async () => {
            await updateNetworkHealth();
            resolve();
        };
        request.onerror = () => reject(request.error);
    });
};

const processQueue = async () => {
    const transaction = db.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();
    
    request.onsuccess = async () => {
        const items = request.result;
        for (const item of items) {
            if (item.status === 'pending' && item.retries < 3) {
                await sendChunk(item);
            }
        }
    };
};

// Network health monitoring
const getQueueSize = async () => {
    return new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const countRequest = store.count();
        
        countRequest.onsuccess = () => resolve(countRequest.result);
        countRequest.onerror = () => reject(countRequest.error);
    });
};

const updateNetworkHealth = async () => {
    const currentQueueSize = await getQueueSize();
    const wasHealthy = networkHealthy;
    networkHealthy = currentQueueSize < 3; // Consider network unhealthy if queue size >= 3
    
    if (wasHealthy !== networkHealthy) {
        console.log(`Network health status changed to: ${networkHealthy ? 'healthy' : 'unhealthy'}`);
    }
    
    // Update UI elements
    const queueSizeElement = document.getElementById('queueSize');
    const networkStatusElement = document.getElementById('networkStatus');
    const clearButton = document.getElementById('clearButton');
    
    if (queueSizeElement) queueSizeElement.textContent = currentQueueSize;
    if (networkStatusElement) networkStatusElement.textContent = networkHealthy ? 'healthy' : 'unhealthy';
    if (clearButton) clearButton.disabled = isRecording;
};

// Chunk sending
async function clearQueue() {
    if (isRecording) {
        displayError("Cannot clear queue while recording");
        return;
    }

    const clearButton = document.getElementById('clearButton');
    clearButton.disabled = true;
    clearButton.textContent = 'Clearing...';

    const transaction = db.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    
    try {
        await new Promise((resolve, reject) => {
            const request = store.clear();
            request.onsuccess = resolve;
            request.onerror = () => reject(request.error);
        });
        
        await updateNetworkHealth();
        console.log('Queue cleared');
        displayError("Queue cleared successfully");
    } catch (error) {
        console.error('Error clearing queue:', error);
        displayError("Failed to clear queue");
    } finally {
        clearButton.disabled = false;
        clearButton.textContent = 'Clear Queue';
    }
}

async function sendChunk(item) {
    const formData = new FormData();
    formData.append('audio', item.chunk);
    formData.append('stream_id', item.streamId);
    formData.append('chunk_index', item.chunkIndex);
    
    try {
        // Use the endpoint from global settings
        const endpoint = window.recordingSettings.UPLOAD_ENDPOINT;
        const response = await fetch(endpoint, {
            method: 'POST',
            body: formData
        });
        
        if (response.ok) {
            console.log(`Successfully sent chunk ${item.chunkIndex} to ${endpoint}`);
            await removeFromQueue(item.id);
        } else {
            console.log(`Failed to send chunk ${item.chunkIndex} to ${endpoint}, will retry later`);
            // Update retry count
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            item.retries++;
            await store.put(item);
        }
    } catch (error) {
        console.error('Error sending chunk:', error);
        // Will be retried on next processQueue
    }
}

function generateUUID() {
    return crypto.randomUUID();
}

async function startRecording(options = {}) {
    if (isRecording) {
        console.log('Already recording, ignoring start request');
        return;
    }
    
    // Reset state before starting new recording
    resetRecordingState();
    
    const chunkLength = options.chunkLength || 2000; // Default to 2 seconds
    
    currentStreamId = generateUUID();
    console.log('Starting new recording session with ID:', currentStreamId);
    
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ 
            audio: { 
                channelCount: 1,
                sampleRate: 16000,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } 
        });

        recorder = new MediaRecorder(mediaStream, {
            mimeType: 'audio/webm;codecs=opus',
            bitsPerSecond: 128000
        });

        chunkCounter = 0;

        recorder.ondataavailable = async (e) => {
            if (e.data.size === 0) return;
            
            await addToQueue(e.data, currentStreamId, chunkCounter);
            await processQueue();
            chunkCounter++;
        };

        recorder.onstart = () => console.log('Recording started with chunk length:', chunkLength, 'ms');
        recorder.onerror = (e) => console.error('Recording error:', e);

        recorder.start(chunkLength);  // Use configured chunk length
        isRecording = true;

    } catch (error) {
        console.error('Error initializing recorder:', error);
        resetRecordingState();
    }
}

function resetRecordingState() {
    isRecording = false;
    chunkCounter = 0;
    currentStreamId = null;
    if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop());
        mediaStream = null;
    }
}

async function stopRecording() {
    if (!isRecording) return;
    
    try {
        isRecording = false;
        
        // Create a promise that resolves when the final chunk is processed
        const finalChunkPromise = new Promise((resolve) => {
            recorder.addEventListener('dataavailable', () => resolve(), { once: true });
        });

        // Stop recording and wait for final chunk
        recorder.stop();
        await finalChunkPromise;
        
        resetRecordingState();
    } catch (error) {
        console.error('Error stopping recorder:', error);
        resetRecordingState();
    }
}

// Initialize and check for unsent chunks on startup
async function initialize() {
    try {
        await initDB();
        
        // Check for unsent chunks
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();
        
        request.onsuccess = async () => {
            const unsentChunks = request.result;
            if (unsentChunks.length > 0) {
                console.log(`Found ${unsentChunks.length} unsent chunks from previous session(s)`);
                await updateNetworkHealth();
                await processQueue();
            }
        };
        
        // Set up periodic queue processing
        setInterval(processQueue, 5000);
        
        // Add window unload handler to log any unsent chunks
        window.addEventListener('beforeunload', async () => {
            const size = await getQueueSize();
            if (size > 0) {
                console.log(`Warning: ${size} chunks still in queue when page closed`);
            }
        });
        
        console.log('Audio recording system initialized');
    } catch (error) {
        console.error('Failed to initialize:', error);
    }
}

// Call initialize when the script loads
initialize();