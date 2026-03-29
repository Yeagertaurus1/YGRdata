// server.js - YGR Data Backend
//
// Deployment notes:
// - Deploy this file + package.json to Render.
// - After Render gives a URL, update BACKEND_URL in index.html and admin.html.
// - In Paystack dashboard, set Webhook URL to: https://YOUR_RENDER_URL/webhook
// - In this file, later restrict CORS origin to your Netlify frontend URL.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// NOTE: These keys are loaded from environment variables for security.
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_WEBHOOK_SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;
const REMADATA_API_KEY = process.env.REMADATA_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const orders = [];
const complaints = [];

// Only allow the Netlify frontend to call this backend (for security).
// You can override with CORS_ORIGIN env var for local testing.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'https://ygrdata.netlify.app'
  })
);
0
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const sig = req.headers['x-paystack-signature'];

    const hash = crypto
      .createHmac('sha512', PAYSTACK_WEBHOOK_SECRET)
      .update(req.body)
      .digest('hex');

    if (hash !== sig) {
      return res.status(400).send('Invalid signature');
    }

    let event;
    try {
      event = JSON.parse(req.body.toString('utf8'));
    } catch (err) {
      return res.status(400).send('Invalid JSON');
    }

    if (event.event === 'charge.success') {
      const metadata = event.data?.metadata || {};
      const { network, bundle, recipientNumber } = metadata;

      if (network && bundle && recipientNumber) {
        sendData({ network, phone: recipientNumber, bundle })
          .then(r => console.log('Webhook sent:', r))
          .catch(e => console.error('Webhook error:', e.message));
      } else {
        console.warn('Webhook charge.success missing metadata for sendData', {
          network,
          bundle,
          recipientNumber
        });
      }
    }

    return res.status(200).send('OK');
  }
);

app.use(express.json());

async function fetchRemaBundles(network) {
  const resp = await axios.get('https://remadata.com/api/bundles', {
    headers: {
      'X-API-KEY': REMADATA_API_KEY
    },
    params: {
      network
    }
  });
  return resp.data;
}

async function sendData({ network, phone, bundle }) {
  // Convert bundle like '1GB' to volumeInMB
  const gb = parseInt(bundle);
  const volumeInMB = gb * 1024;

  // Generate unique reference
  const ref = crypto.randomUUID();

  const payload = {
    phone,
    volumeInMB,
    networkType: network.toLowerCase(),
    ref
  };

  const resp = await axios.post(
    'https://remadata.com/api/buy-data',
    payload,
    {
      headers: {
        'X-API-KEY': REMADATA_API_KEY,
        'Content-Type': 'application/json'
      }
    }
  );

  return resp.data;
}

app.post('/verify-payment', async (req, res) => {
  const { reference, recipientNumber, network, bundle, validity } = req.body || {};

  if (!reference || !recipientNumber || !network || !bundle) {
    return res.status(400).json({
      success: false,
      message: 'Missing required fields'
    });
  }

  try {
    const verifyResp = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const payData = verifyResp.data;
    if (!payData.status || payData.data.status !== 'success') {
      return res.status(400).json({
        success: false,
        message: 'Payment not successful'
      });
    }

    const amountKobo = payData.data.amount;
    const amountGHS = amountKobo / 100;

    let sendResult = null;
    let status = 'completed';
    try {
      sendResult = await sendData({
        network,
        phone: recipientNumber,
        bundle
      });
      console.log('RemaData response:', sendResult);
    } catch (err) {
      console.error('Error sending data via RemaData:', err.message);
      status = 'failed';
    }

    const order = {
      id: orders.length + 1,
      reference,
      network,
      bundle,
      validity,
      recipientNumber,
      amount: amountGHS,
      status,
      createdAt: new Date().toISOString()
    };
    orders.push(order);

    if (status === 'completed') {
      return res.json({
        success: true,
        message: 'Payment verified and data purchase initiated',
        order
      });
    } else {
      return res.status(500).json({
        success: false,
        message: 'Payment verified but data sending failed. Please contact support.',
        order
      });
    }
  } catch (err) {
    console.error('Error verifying payment:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: 'Could not verify payment. Please try again later.'
    });
  }
});

app.get('/bundles/:network', async (req, res) => {
  const network = req.params.network;
  try {
    const data = await fetchRemaBundles(network);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching Rema bundles:', err.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to fetch bundles'
    });
  }
});

app.post('/complaint', (req, res) => {
  const { phone, message } = req.body || {};
  if (!message) {
    return res.status(400).json({
      success: false,
      message: 'Message is required'
    });
  }
  const complaint = {
    id: complaints.length + 1,
    phone: phone || null,
    message,
    createdAt: new Date().toISOString()
  };
  complaints.push(complaint);
  return res.json({ success: true });
});

app.get('/track-order', (req, res) => {
  const { reference } = req.query;
  if (!reference) {
    return res.status(400).json({ success: false, message: 'Reference is required' });
  }

  const order = orders.find(o => o.reference === reference);
  if (!order) {
    return res.status(404).json({ success: false, message: 'Order not found' });
  }

  return res.json({ success: true, order });
});

app.get('/admin/orders', (req, res) => {
  const { password } = req.query;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const totalOrders = orders.length;
  const successfulOrders = orders.filter(o => o.status === 'completed').length;
  const pendingOrders = orders.filter(o => o.status === 'pending').length;
  const totalRevenue = orders
    .filter(o => o.status === 'completed')
    .reduce((sum, o) => sum + (o.amount || 0), 0);

  return res.json({
    stats: {
      totalRevenue,
      totalOrders,
      successfulOrders,
      pendingOrders
    },
    orders: orders.slice().reverse()
  });
});

app.get('/', (req, res) => {
  res.send('YGR Data Backend is running');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

