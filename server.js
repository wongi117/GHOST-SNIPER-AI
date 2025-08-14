const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// Default route → load wallet-test.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'wallet-test.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Ghost Sniper running on port ${PORT}`);
});