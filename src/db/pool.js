const { Pool } = require('pg');

const sslConfig = process.env.DATABASE_URL.includes('localhost') || process.env.DATABASE_URL.includes('127.0.0.1')
  ? false
  : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
    ssl: {
    rejectUnauthorized: false  // For local development only
  }
});

pool.on('connect', (client) => {
  client.query('SET search_path TO leads_dashboard, public;');
});

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL client error:', err);
  process.exit(-1);
});

/**
 * Execute a raw SQL query
 * @param {string} text - SQL query string with $1, $2 placeholders
 * @param {Array}  params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  if (process.env.NODE_ENV !== 'production') {
    console.log('Query executed', { text: text.slice(0, 80), duration, rows: res.rowCount });
  }
  return res;
}

/**
 * Get a client for transactions
 */
async function getClient() {
  return pool.connect();
}

module.exports = { query, getClient };
