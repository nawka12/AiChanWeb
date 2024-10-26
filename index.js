const express = require('express');
const bodyParser = require('body-parser');
require('dotenv').config();

const { searchQuery } = require('./searchlogic.js');
const Anthropic = require('@anthropic-ai/sdk');

// Add this function at the beginning of the file
const createSearchMessage = (queries, isComplete = false) => {
    const totalQueries = queries.length;
    const totalResults = totalQueries * MAX_SEARCH_RESULTS;
    if (isComplete) {
        return {
            type: 'searchStatus',
            content: `Done! Searched ${totalQueries} ${totalQueries === 1 ? 'query' : 'queries'} with ${totalResults} results.`,
            queries: queries
        };
    } else {
        return {
            type: 'searchStatus',
            content: `Searching the web for "${queries[queries.length - 1]}"...`,
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
    systemMessage: (command, username) => `You are Ai-chan, a helpful assistant in a form of web application. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. You have 3 modes; offline, search (connects you to the internet with up to 3 search results), and deepsearch (connects you to the internet with up to 10 search results). ${command === 'search' || command === 'deepsearch' ? `You're connected to the internet with ${command} command.` : "You're using offline mode."} Keep your answer as short as possible. You're currently talking to ${username}.`,
    querySystemMessage: (username) => `Your job is to convert questions into a search query based on context provided. Don't reply with anything other than search query with no quote. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    queryDeepSystemMessage: (username) => `Your job is to convert questions into search queries based on context provided. Don't reply with anything other than search queries with no quote, separated by comma. Each search query will be performed separately, so make sure to write the queries straight to the point. Always assume you know nothing about the user's question. Today is ${new Date().toLocaleDateString('en-US', DATE_OPTIONS)}. If the user asking a question about himself, his name is ${username}.`,
    contextSystemMessage: `Your job is to analyze conversations and create a concise context summary that captures the key information needed to understand follow-up questions.`,
};

// Initialize Anthropic client
const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

// State management
const userConversations = {};
const userContexts = {};

// Helper functions
const processContext = async (userId) => {
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

const performSearch = async (command, queryAI, commandContent) => {
    if (command === 'search') {
        const finalQuery = queryAI.content[0].text;
        console.log(`Searching the web for: ${finalQuery}`);
        const searchResult = await searchQuery(finalQuery);
        const results = searchResult.results.slice(0, MAX_SEARCH_RESULTS);
        return formatSearchResults(results, commandContent);
    } else if (command === 'deepsearch') {
        const queries = queryAI.content[0].text.split(',').map(q => q.trim());
        let allResults = [];
        
        for (let query of queries) {
            console.log(`Searching the web for: ${query}`);
            const searchResult = await searchQuery(query);
            allResults = allResults.concat(searchResult.results.slice(0, MAX_SEARCH_RESULTS));
        }
        
        return formatSearchResults(allResults, commandContent);
    }
};

const formatSearchResults = (results, commandContent) => {
    return `Here's more data from the web about my question:\n\n${results.map(result => `URL: ${result.url}, Title: ${result.title}, Content: ${result.content}`).join('\n\n')}\n\nMy question is: ${commandContent}`;
};

// Express app setup
const app = express();
const port = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static('public'));

app.post('/chat', async (req, res) => {
    try {
        const { message, userId, command } = req.body;

        // Initialize user data if it doesn't exist
        if (!userContexts[userId]) userContexts[userId] = '';
        if (!userConversations[userId]) userConversations[userId] = [];

        let messages = [];
        let searchContent = '';

        if (command === 'search' || command === 'deepsearch') {
            try {
                if (userConversations[userId].length >= 2) {
                    userContexts[userId] = await processContext(userId);
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

                for (let i = 0; i < queries.length; i++) {
                    const searchMessage = createSearchMessage(queries.slice(0, i + 1));
                    res.write(`data: ${JSON.stringify(searchMessage)}\n\n`);
                }

                searchContent = await performSearch(command, { content: [{ text: queries.join(',') }] }, message);
                messages.push({ role: "user", content: searchContent });

                const completeSearchMessage = createSearchMessage(queries, true);
                res.write(`data: ${JSON.stringify(completeSearchMessage)}\n\n`);
            } catch (error) {
                console.error("Search Error:", error);
                res.status(500).json({ error: 'There was an error processing your search request.' });
                return;
            }
        } else {
            messages.push({ role: "user", content: message });
            if (userConversations[userId].length >= 2) {
                userContexts[userId] = await processContext(userId);
            }
        }

        messages = [...userConversations[userId], ...messages];
        messages = messages.filter((message, index, self) =>
            index === self.findIndex((t) => t.role === message.role && JSON.stringify(t.content) === JSON.stringify(message.content))
        );

        console.log("Messages to be sent to API:", JSON.stringify(messages, null, 2));

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
        res.status(500).json({ error: 'There was an error processing your request.' });
    }
});

// Add a new endpoint to get the conversation history
app.get('/conversation/:userId', (req, res) => {
    const { userId } = req.params;
    res.json({ conversation: userConversations[userId] || [] });
});

app.listen(port, () => {
    console.log(`Ai-chan web app is running on port ${port}`);
});
