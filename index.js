const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const Anthropic = require('@anthropic-ai/sdk');

// At the top of your file, after loading dotenv
console.log("Loaded API Key:", process.env.ANTHROPIC_API_KEY ? "Set" : "Not set");

// Add this function at the beginning of the file
const createSearchMessage = (queries, isComplete = false, totalQueries = null, currentProgress = null) => {
    const currentQuery = queries[queries.length - 1];
    const total = totalQueries || queries.length;
    const progress = currentProgress || queries.length;
    
    if (isComplete) {
        return {
            type: 'searchStatus',
            content: `Done! Searched ${total} ${total === 1 ? 'query' : 'queries'} with ${total * MAX_SEARCH_RESULTS} results.`,
            queries: queries
        };
    } else {
        return {
            type: 'searchStatus',
            content: `Searching the web for "${currentQuery}"... (${progress}/${total})`,
            queries: queries
        };
    }
};

// Constants
const AI_MODEL = 'claude-3-5-sonnet-latest';
const MAX_TOKENS = 4096;
const MAX_SEARCH_RESULTS = 3;
const DATE_OPTIONS = { day: 'numeric', month: 'long', year: 'numeric' };

// Configuration
const config = {
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of web application. Your name is taken from Kizuna Ai, a virtual YouTuber. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible. You're currently talking to ${username}.`,
    querySystemMessage: (username) => `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    queryDeepSystemMessage: (username) => `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`,
};

// State management
const userConversations = {};
const userContexts = {};
const userSearchStatuses = {}; // This will now store an array of search statuses for each user
const userCommands = {};

// Helper functions
const processContext = async (userId, anthropic) => {
    if (userConversations[userId].length < 2) return '';

    const conversationHistory = userConversations[userId];
    const lastConversation = conversationHistory.slice(-2).map(conv => {
        if (typeof conv.content === 'string') {
            return conv.content;
        } else if (Array.isArray(conv.content)) {
            return conv.content.map(item => item.type === 'text' ? item.text : '[Image]').join(' ');
        }
        return JSON.stringify(conv.content);
    }).join('\n');

    const contextPrompt = userContexts[userId]
        ? `Last context summary: ${userContexts[userId]}\nLast conversation: ${lastConversation}`
        : `Last conversation: ${lastConversation}`;

    const contextAI = await anthropic.messages.create({
        model: AI_MODEL,
        max_tokens: 200,
        system: config.contextSystemMessage,
        messages: [
            {"role": "user", "content": contextPrompt}
        ],
    });
    
    return contextAI.content[0].text;
};

const performSearch = async (command, queryAI, commandContent, res) => {
    if (command === 'search') {
        const finalQuery = queryAI.content[0].text;
        res.write(`data: ${JSON.stringify(createSearchMessage([finalQuery], false, 1, 1))}\n\n`);
        const searchResult = await searchQuery(finalQuery);
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        const queries = queryAI.content[0].text.split(',').map(q => q.trim());
        let allResults = [];
        const totalQueries = queries.length;
        
        // Process one query at a time
        for (let i = 0; i < queries.length; i++) {
            const currentQuery = queries[i];
            const currentProgress = i + 1;  // Add current progress
            
            // Send status before each search
            res.write(`data: ${JSON.stringify(createSearchMessage([currentQuery], false, totalQueries, currentProgress))}\n\n`);
            
            const searchResult = await searchQuery(currentQuery);
            allResults = allResults.concat(searchResult.results.slice(0, MAX_SEARCH_RESULTS));
        }
        
        return formatSearchResults(allResults, commandContent);
    }
};

const formatSearchResults = (results, commandContent) => {
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
};

// Move this outside of the app.post('/chat') handler
const getAnthropicClient = () => {
    return new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
    });
};

// Express app setup
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

app.post('/chat', async (req, res) => {
    try {
        // Check if API key is set
        if (!process.env.ANTHROPIC_API_KEY) {
            res.write(`data: ${JSON.stringify({ type: 'final', response: "API key is not set. Please set up your Anthropic API key in the settings." })}\n\n`);
            res.end();
            return;
        }

        // Get a fresh Anthropic client for each request
        const anthropic = getAnthropicClient();

        const { message, userId, command } = req.body;

        // Initialize user data if it doesn't exist
        if (!userContexts[userId]) userContexts[userId] = '';
        if (!userConversations[userId]) userConversations[userId] = [];
        if (!userSearchStatuses[userId]) userSearchStatuses[userId] = [];
        
        // Store the command
        userCommands[userId] = command;

        let messages = [];
        let searchContent = '';
        let messageIndex = userConversations[userId].length; // Get current message index

        if (command === 'search' || command === 'deepsearch') {
            try {
                if (userConversations[userId].length >= 2) {
                    userContexts[userId] = await processContext(userId, anthropic);
                }

                const queryContext = `${userContexts[userId] ? `Context: ${userContexts[userId]}\n` : ''}Question: ${message}`;

                const queryAI = await anthropic.messages.create({
                    model: AI_MODEL,
                    max_tokens: 100,
                    temperature: 0.7,
                    system: command === 'search' ? config.querySystemMessage(userId) : config.queryDeepSystemMessage(userId),
                    messages: [
                        {"role": "user", "content": queryContext}
                    ],
                });

                const queries = command === 'search' 
                    ? [queryAI.content[0].text]
                    : queryAI.content[0].text.split(',').map(q => q.trim());

                searchContent = await performSearch(command, { content: [{ text: queries.join(',') }] }, message, res);
                messages.push({ role: "user", content: searchContent });

                const completeSearchMessage = createSearchMessage(queries, true);
                // Store the search status with its associated message index
                userSearchStatuses[userId].push({
                    messageIndex: messageIndex,
                    status: completeSearchMessage
                });
                res.write(`data: ${JSON.stringify({
                    ...completeSearchMessage,
                    messageIndex: messageIndex
                })}\n\n`);
            } catch (error) {
                console.error("Search Error:", error);
                res.status(500).json({ error: 'There was an error processing your search request.' });
                return;
            }
        } else {
            messages.push({ role: "user", content: message });
            if (userConversations[userId].length >= 2) {
                userContexts[userId] = await processContext(userId, anthropic);
            }
        }

        messages = [...userConversations[userId], ...messages];
        messages = messages.filter((message, index, self) =>
            index === self.findIndex((t) => t.role === message.role && JSON.stringify(t.content) === JSON.stringify(message.content))
        );

        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

        console.log("Using API Key:", process.env.ANTHROPIC_API_KEY.substring(0, 5) + '...');  // Log first 5 characters of API key

        const response = await anthropic.messages.create({
            model: AI_MODEL,
            max_tokens: MAX_TOKENS,
            system: config.systemMessage(command, 'User'),
            messages: messages,
        });

        console.log("API Response:", JSON.stringify(response, null, 2));

        let aiResponse = '';
        if (response && response.content) {
            if (Array.isArray(response.content) && response.content.length > 0) {
                aiResponse = response.content[0].text || '';
            } else if (typeof response.content === 'string') {
                aiResponse = response.content;
            }
        }

        // If aiResponse is empty, check if it's a predefined response
        if (!aiResponse) {
            const lastUserMessage = messages[messages.length - 1].content.toLowerCase();
            if (lastUserMessage === 'jomok') {
                aiResponse = 'aiaiai';
            } else {
                aiResponse = "I apologize, but I don't have a response at the moment.";
            }
        }

        userConversations[userId].push({ role: "user", content: message });
        userConversations[userId].push({ 
            role: "assistant", 
            content: aiResponse 
        });

        // Send the entire conversation history along with the response
        res.write(`data: ${JSON.stringify({ type: 'final', response: aiResponse, conversation: userConversations[userId] })}\n\n`);
        res.end();
    } catch (error) {
        console.error("API Error:", error);
        let errorMessage = "I apologize, but there was an error processing your request. Please try again later.";
        
        // Check if the error is related to an invalid API key
        if (error.status === 401) {
            errorMessage = "There was an error with the API key. Please check your Anthropic API key in the settings.";
        }
        
        res.write(`data: ${JSON.stringify({ type: 'final', response: errorMessage })}\n\n`);
        res.end();
    }
});

// Modify the /conversation endpoint
app.get('/conversation/:userId', (req, res) => {
    const { userId } = req.params;
    res.json({ 
        conversation: userConversations[userId] || [],
        searchStatuses: userSearchStatuses[userId] || [], // Changed to return array of statuses
        command: userCommands[userId] || 'offline'
    });
});

// Update the save-api-key endpoint
app.post('/save-api-key', (req, res) => {
    const { apiKey } = req.body;
    
    if (!apiKey) {
        return res.status(400).json({ error: 'API key is required' });
    }

    const envPath = path.resolve(__dirname, '.env');
    let envContent = '';

    // Check if .env file exists
    if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');
    }

    // Update or add ANTHROPIC_API_KEY
    if (envContent.includes('ANTHROPIC_API_KEY=')) {
        envContent = envContent.replace(/ANTHROPIC_API_KEY=.*/, `ANTHROPIC_API_KEY=${apiKey}`);
    } else {
        envContent += `\nANTHROPIC_API_KEY=${apiKey}`;
    }

    // Write the content to the .env file
    fs.writeFileSync(envPath, envContent.trim());

    // Update the environment variable directly
    process.env.ANTHROPIC_API_KEY = apiKey;

    console.log("API Key updated:", apiKey.substring(0, 5) + '...');  // Log first 5 characters of new API key

    res.json({ message: 'API key saved and updated successfully' });
});

// Modify the get-api-key endpoint
app.get('/get-api-key', (req, res) => {
    const apiKey = process.env.ANTHROPIC_API_KEY || '';
    res.json({ 
        apiKey: apiKey ? '*'.repeat(apiKey.length) : '',
        isSet: !!apiKey
    });
});

// Add this new endpoint
app.post('/reset/:userId', (req, res) => {
    const { userId } = req.params;
    
    // Clear all user data
    delete userConversations[userId];
    delete userContexts[userId];
    delete userSearchStatuses[userId];
    delete userCommands[userId];
    
    res.json({ success: true });
});

// Add this new endpoint after your other endpoints
app.post('/update-command', (req, res) => {
    const { userId, command } = req.body;
    try {
        userCommands[userId] = command;
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating command:', error);
        res.status(500).json({ error: 'Failed to update command' });
    }
});

app.listen(port, () => {
    console.log(`Ai-chan web app is running on port ${port}`);
});
