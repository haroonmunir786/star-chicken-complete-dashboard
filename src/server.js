require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '*')
  .split(',')
  .map(o => o.trim());

app.use(helmet());
app.use(morgan('tiny'));
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: allowedOrigins.includes('*') ? true : allowedOrigins,
  credentials: true
}));

// Health check — Render / uptime monitors hit this
app.get('/', (req, res) => res.json({ ok: true, service: 'star-chicken-backend' }));
app.get('/health', (req, res) => res.json({ status: 'healthy', time: new Date().toISOString() }));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/branches', require('./routes/branches'));
app.use('/api/stock', require('./routes/stock'));
app.use('/api/transfers', require('./routes/transfers'));
app.use('/api/stock-requests', require('./routes/stockRequests'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/employees', require('./routes/employees'));

// 404 handler
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

// Central error handler
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Star Chicken backend running on port ${PORT}`));
