const chatContainer = document.getElementById('chat-container');
        const userInput = document.getElementById('user-input');
        const commandSelect = document.getElementById('command-select');
        let userId = Cookies.get('userId') || generateUserId();

        function generateUserId() {
            const newUserId = 'user-' + Math.random().toString(36).substr(2, 9);
            Cookies.set('userId', newUserId, { expires: 365 });
            return newUserId;
        }

        async function loadConversation() {
            try {
                const response = await fetch(`/conversation/${userId}`);
                const data = await response.json();
                
                // Restore command selection
                if (data.command) {
                    commandSelect.value = data.command;
                }
                
                // Restore conversation and search statuses
                if (data.conversation) {
                    let currentIndex = 0;
                    data.conversation.forEach(message => {
                        appendMessage(message.role === 'user' ? 'User' : 'Ai-chan', message.content);
                        
                        // Check if there's a search status for this message
                        const searchStatus = data.searchStatuses.find(s => s.messageIndex === currentIndex);
                        if (searchStatus) {
                            appendSearchStatus(searchStatus.status.content, searchStatus.status.queries);
                        }
                        currentIndex++;
                    });
                }
            } catch (error) {
                console.error('Error loading conversation:', error);
            }
        }

        async function sendMessage() {
            const message = userInput.value.trim();
            const command = commandSelect.value;
            if (!message) return;  // Prevent sending empty messages or just whitespace

            appendMessage('User', message);
            userInput.value = '';
            // Reset textarea height after clearing
            userInput.style.height = 'auto';

            try {
                const response = await fetch('/chat', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ message, userId, command }),
                });

                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let searchStatusElement = null;
                let allQueries = [];

                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value);
                    const messages = chunk.split('\n\n').filter(msg => msg.trim() !== '');

                    for (const msg of messages) {
                        const data = JSON.parse(msg.replace('data: ', ''));
                        if (data.type === 'searchStatus') {
                            allQueries = data.queries;
                            if (!searchStatusElement) {
                                searchStatusElement = appendSearchStatus(data.content, allQueries);
                                // Store the message index with the search status element
                                searchStatusElement.dataset.messageIndex = data.messageIndex;
                            } else {
                                updateSearchStatus(searchStatusElement, data.content, allQueries);
                            }
                        } else if (data.type === 'final') {
                            appendMessage('Ai-chan', data.response);
                        }
                    }
                }
            } catch (error) {
                console.error('Error:', error);
                appendMessage('Ai-chan', 'Sorry, there was an error processing your request. Please try again later.');
            }
        }

        function appendMessage(sender, message) {
            const messageElement = document.createElement('div');
            messageElement.className = 'p-4 rounded-lg ' + (sender === 'User' ? 'bg-blue-100' : 'bg-white border border-gray-200');
            if (document.body.classList.contains('dark-mode')) {
                messageElement.classList.add('dark-mode');
            }

            // Format the message
            let formattedMessage = message
                // First, handle lists before converting newlines to <br>
                .split('\n')
                .map(line => {
                    // Handle bullet points
                    if (/^[\s]*[-*][\s](.+)$/.test(line)) {
                        const content = line.match(/^[\s]*[-*][\s](.+)$/)[1];
                        return `<li>${content}</li>`;
                    }
                    // Handle numbered lists
                    else if (/^[\s]*(\d+)[\.\)][\s](.+)$/.test(line)) {
                        const [_, number, content] = line.match(/^[\s]*(\d+)[\.\)][\s](.+)$/);
                        return `<li value="${number}">${content}</li>`;
                    }
                    return line;
                })
                // Join with empty string for consecutive list items
                .map((line, i, arr) => {
                    const currentIsListItem = line.includes('<li');
                    const nextIsListItem = i < arr.length - 1 && arr[i + 1].includes('<li');
                    return currentIsListItem && nextIsListItem ? line : line + '\n';
                })
                .join('')
                // Wrap consecutive <li> elements with ul/ol based on their type
                .replace(/((?:<li[^>]*>.*?<\/li>)+)/g, (match) => {
                    const isNumbered = match.includes('value="');
                    return isNumbered ? `<ol>${match}</ol>` : `<ul>${match}</ul>`;
                })
                // Handle code blocks
                .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
                    const sanitizedCode = code.trim()
                        .replace(/[<>&]/g, c => ({
                            '<': '&lt;',
                            '>': '&gt;',
                            '&': '&amp;'
                        }[c]));
                    
                    return `<div class="code-wrapper"><pre><code class="language-${lang}">${sanitizedCode}</code></pre></div>`;
                })
                // Handle inline code
                .replace(/`([^`]+)`/g, (_, code) => {
                    const sanitizedCode = code
                        .replace(/[<>&]/g, c => ({
                            '<': '&lt;',
                            '>': '&gt;',
                            '&': '&amp;'
                        }[c]));
                    return `<span class="code-wrapper"><code>${sanitizedCode}</code></span>`;
                })
                // Now handle the rest of the formatting
                .replace(/\n/g, '<br>')  // Convert remaining newlines to <br>
                .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');  // Handle bold text

            messageElement.innerHTML = `
                <div class="flex items-start">
                    <div class="flex-shrink-0 ${sender === 'User' ? 'bg-blue-500' : 'bg-green-500'} rounded-full p-2 mr-3">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-white" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd" />
                        </svg>
                    </div>
                    <div>
                        <p class="font-semibold ${sender === 'User' ? 'text-blue-600' : 'text-green-600'}">${sender}</p>
                        <div class="text-gray-700 mt-1 formatted-content">${formattedMessage}</div>
                    </div>
                </div>
            `;
            chatContainer.appendChild(messageElement);
            chatContainer.scrollTop = chatContainer.scrollHeight;
        }

        function appendSearchStatus(content, queries) {
            const statusElement = document.createElement('div');
            statusElement.className = 'search-status mb-2';
            statusElement.innerHTML = `
                <span class="status-text">${content}</span>
                <ul class="search-queries">
                    ${queries.map(q => `<li>${q}</li>`).join('')}
                </ul>
            `;
            statusElement.addEventListener('click', () => {
                statusElement.querySelector('.search-queries').style.display = 
                    statusElement.querySelector('.search-queries').style.display === 'none' ? 'block' : 'none';
            });
            chatContainer.appendChild(statusElement);
            chatContainer.scrollTop = chatContainer.scrollHeight;
            return statusElement;
        }

        function updateSearchStatus(element, content, queries) {
            element.querySelector('.status-text').textContent = content;
            element.querySelector('.search-queries').innerHTML = queries.map(q => `<li>${q}</li>`).join('');
        }

        function resetConversation() {
            chatContainer.innerHTML = '';
            userId = generateUserId();
            
            // Reset the command to offline
            commandSelect.value = 'offline';
            
            // Make an API call to clear the user's data
            fetch(`/reset/${userId}`, { method: 'POST' })
                .catch(error => console.error('Error resetting conversation:', error));
            
            appendMessage('System', 'New conversation started.');
        }

        userInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') {
                if (e.shiftKey) {
                    // Allow the default behavior for Shift+Enter (new line)
                    return;
                } else {
                    e.preventDefault();
                    const messageContent = this.value.trim();
                    if (messageContent) {  // Only send if there's actual content
                        sendMessage();
                    }
                }
            }
        });

        // Load conversation on page load
        loadConversation();

        async function loadSettings() {
            try {
                const response = await fetch('/get-api-key');
                const data = await response.json();
                const apiKeyInput = document.getElementById('api-key');
                if (data.isSet) {
                    apiKeyInput.value = data.apiKey; // Will show asterisks matching API key length
                    apiKeyInput.placeholder = 'Enter new API key to change';
                } else {
                    apiKeyInput.value = '';
                    apiKeyInput.placeholder = 'Enter your Anthropic API key';
                }
            } catch (error) {
                console.error('Error loading API key:', error);
            }
        }

        function openSettings() {
            document.getElementById('settings-modal').classList.remove('hidden');
            document.getElementById('dark-mode-toggle').checked = document.body.classList.contains('dark-mode');
            loadSettings(); // Load settings when opening the modal
        }

        function closeSettings() {
            document.getElementById('settings-modal').classList.add('hidden');
        }

        async function saveSettings() {
            const darkMode = document.getElementById('dark-mode-toggle').checked;
            const apiKey = document.getElementById('api-key').value;

            // Save dark mode preference
            localStorage.setItem('darkMode', darkMode);
            toggleDarkMode(darkMode);

            // Save API key only if it's not empty and not just asterisks
            if (apiKey && !/^\*+$/.test(apiKey)) {
                try {
                    const response = await fetch('/save-api-key', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ apiKey }),
                    });

                    if (response.ok) {
                        alert('Settings saved successfully');
                        loadSettings(); // Reload settings to update the input field
                    } else {
                        alert('Failed to save API key');
                    }
                } catch (error) {
                    console.error('Error saving API key:', error);
                    alert('An error occurred while saving the API key');
                }
            } else {
                alert('Settings saved successfully');
            }

            closeSettings();
        }

        function toggleDarkMode(enabled) {
            document.body.classList.toggle('dark-mode', enabled);
        }

        // Load dark mode setting on page load
        document.addEventListener('DOMContentLoaded', () => {
            const darkMode = localStorage.getItem('darkMode') === 'true';
            toggleDarkMode(darkMode);
            document.getElementById('dark-mode-toggle').checked = darkMode;
        });

        // Add this after your existing variable declarations at the top
        commandSelect.addEventListener('change', async function() {
            try {
                await fetch('/update-command', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ 
                        userId: userId,
                        command: this.value 
                    }),
                });
            } catch (error) {
                console.error('Error saving command:', error);
            }
        });

        // Add this to your existing script.js
        document.getElementById('mobile-menu-toggle').addEventListener('click', function() {
            const mobileMenu = document.getElementById('mobile-menu');
            mobileMenu.classList.toggle('hidden');
        });

        // Add this after your existing code
        document.getElementById('user-input').addEventListener('input', function() {
            // Reset height to auto to get the correct scrollHeight
            this.style.height = 'auto';
            
            // Set new height based on scrollHeight
            const newHeight = Math.min(this.scrollHeight, 200);
            this.style.height = newHeight + 'px';
        });
