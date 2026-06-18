const express = require('express');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Parser } = require('json2csv');
const fs = require('fs');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.use(express.static('public'));
app.use(express.json());

// ── AUTO COLUMN DETECTION ──────────────────────────────────────────────────
function detectColumn(headers, pattern) {
  return headers.find(h => pattern.test(h.trim())) || null;
}

// ── PHONE RULES ────────────────────────────────────────────────────────────
const phoneRules = {
  IN: { digits: 10, name: 'India' },
  SG: { digits: 8,  name: 'Singapore' },
  US: { digits: 10, name: 'USA' },
  UK: { digits: 10, name: 'UK' },
  GB: { digits: 10, name: 'UK' },
  AU: { digits: 9,  name: 'Australia' },
  AE: { digits: 9,  name: 'UAE' },
  MY: { digits: 9,  name: 'Malaysia' },
  PH: { digits: 10, name: 'Philippines' },
  ID: { digits: 10, name: 'Indonesia' },
};

// ── DATE FORMATS ───────────────────────────────────────────────────────────
const validDateFormats = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{2}-\d{2}-\d{4}$/,
  /^\d{2}\/\d{2}\/\d{4}$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  /^\d{2}\.\d{2}\.\d{4}$/,
  /^\d{4}-\d{2}-\d{2}T[\d:Z.]+$/
];

// ── VALID PAYMENT MODES ────────────────────────────────────────────────────
const VALID_PAYMENT_MODES = [
  'cash', 'card', 'credit_card', 'debit_card', 'credit card', 'debit card',
  'upi', 'net_banking', 'netbanking', 'net banking',
  'wallet', 'paytm', 'gpay', 'google_pay', 'google pay', 'phonepe',
  'paypal', 'stripe', 'bank_transfer', 'bank transfer',
  'cod', 'cash on delivery', 'emi', 'cryptocurrency', 'crypto'
];

// ── VALIDATORS ─────────────────────────────────────────────────────────────
function validatePhone(phone, countryCode) {
  if (!phone || phone.toString().trim() === '')
    return { valid: false, reason: 'Phone number is missing' };
  const digits = phone.toString().replace(/\D/g, '');
  const rule = phoneRules[countryCode?.toUpperCase()];
  if (!rule) return { valid: true };
  if (digits.length !== rule.digits)
    return { valid: false, reason: `Phone must be ${rule.digits} digits for ${rule.name} (got ${digits.length})` };
  return { valid: true };
}

function validateDate(dateStr) {
  if (!dateStr || dateStr.trim() === '')
    return { valid: false, reason: 'Date is missing' };

  const trimmed = dateStr.trim();
  const formatMatch = validDateFormats.some(fmt => fmt.test(trimmed));
  if (!formatMatch)
    return { valid: false, reason: `Unrecognised date format: "${dateStr}"` };

  // extract day, month, year based on format and check it's a real calendar date
  let day, month, year;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || /^\d{4}\/\d{2}\/\d{2}$/.test(trimmed)) {
    [year, month, day] = trimmed.split(/[-/]/).map(Number);
  } else if (/^\d{2}-\d{2}-\d{4}$/.test(trimmed) || /^\d{2}\/\d{2}\/\d{4}$/.test(trimmed) || /^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
    [day, month, year] = trimmed.split(/[-/.]/).map(Number);
  } else {
    return { valid: true }; // ISO timestamp formats, skip manual check
  }

  if (month < 1 || month > 12)
    return { valid: false, reason: `Invalid month in date: "${dateStr}"` };

  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth)
    return { valid: false, reason: `Invalid day in date: "${dateStr}"` };

  return { valid: true };
}

function validateEmail(email) {
  if (!email || email.trim() === '')
    return { valid: false, reason: 'Email is missing' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
    return { valid: false, reason: 'Invalid email format' };
  return { valid: true };
}

// ── ORDER-LEVEL VALIDATION ─────────────────────────────────────────────────
function validateOrderFields(row, keys) {
  const errors = [];

  // order_id must exist and be non-empty
  if (keys.orderIdKey) {
    const val = row[keys.orderIdKey]?.toString().trim();
    if (!val) errors.push('Order ID is missing');
  }

  // amount must be a positive number
  if (keys.amountKey) {
    const val = row[keys.amountKey]?.toString().trim();
    if (!val) {
      errors.push('Amount is missing');
    } else if (isNaN(parseFloat(val)) || parseFloat(val) < 0) {
      errors.push(`Amount must be a positive number (got "${val}")`);
    }
  }

  // quantity must be a positive integer if present
  if (keys.quantityKey) {
    const val = row[keys.quantityKey]?.toString().trim();
    if (val && (isNaN(parseInt(val)) || parseInt(val) <= 0)) {
      errors.push(`Quantity must be a positive integer (got "${val}")`);
    }
  }

  return errors;
}

// ── PRODUCT-LEVEL VALIDATION ───────────────────────────────────────────────
function validateProductFields(row, keys) {
  const errors = [];

  // product_id or product_name must exist
  if (keys.productIdKey) {
    const val = row[keys.productIdKey]?.toString().trim();
    if (!val) errors.push('Product ID is missing');
  }

  if (keys.productNameKey) {
    const val = row[keys.productNameKey]?.toString().trim();
    if (!val) errors.push('Product name is missing');
  }

  // price must be a positive number if present
  if (keys.priceKey) {
    const val = row[keys.priceKey]?.toString().trim();
    if (val && (isNaN(parseFloat(val)) || parseFloat(val) < 0)) {
      errors.push(`Price must be a positive number (got "${val}")`);
    }
  }

  return errors;
}

// ── PAYMENT MODE VALIDATION ────────────────────────────────────────────────
function validatePaymentMode(value) {
  if (!value || value.toString().trim() === '')
    return { valid: false, reason: 'Payment mode is missing' };
  const normalised = value.toString().trim().toLowerCase();
  if (!VALID_PAYMENT_MODES.includes(normalised))
    return { valid: false, reason: `Unrecognised payment mode: "${value}" (accepted: card, UPI, cash, wallet, net_banking, COD, etc.)` };
  return { valid: true };
}

// ── UPLOAD ROUTE ───────────────────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const rows = [];

  fs.createReadStream(req.file.path)
    .pipe(csvParser())
    .on('data', row => {
      const clean = {};
      Object.keys(row).forEach(k => {
        clean[k.replace(/^\uFEFF/, '').trim()] = row[k];
      });
      rows.push(clean);
    })
    .on('end', () => {
      fs.unlinkSync(req.file.path);

      if (rows.length === 0)
        return res.status(400).json({ error: 'CSV is empty' });

      // ── Auto-detect all column types ──
      const headers = Object.keys(rows[0]);

      const phoneKey       = detectColumn(headers, /phone|mobile|contact|cell/i);
      const emailKey       = detectColumn(headers, /email|e.?mail/i);
      const dateKey        = detectColumn(headers, /date|time|_at|created|signup|order_date/i);
      const countryKey     = detectColumn(headers, /country|cc|region|locale/i);

      // Order-level columns
      const orderIdKey     = detectColumn(headers, /order.?id|order.?no|order.?num/i);
      const amountKey      = detectColumn(headers, /^amount$|total.?amount|order.?amount|price.?total|grand.?total/i);
      const quantityKey    = detectColumn(headers, /^qty$|^quantity$|units/i);

      // Product-level columns
      const productIdKey   = detectColumn(headers, /product.?id|prod.?id|item.?id/i);
      const productNameKey = detectColumn(headers, /product.?name|item.?name|product.?title|prod.?name/i);
      const priceKey       = detectColumn(headers, /^price$|unit.?price|item.?price|product.?price/i);

      // Payment mode
      const paymentKey     = detectColumn(headers, /payment.?mode|payment.?method|pay.?type|payment.?type/i);

      const detectedColumns = {
        phoneKey, emailKey, dateKey, countryKey,
        orderIdKey, amountKey, quantityKey,
        productIdKey, productNameKey, priceKey,
        paymentKey,
      };

      const validRows = [], invalidRows = [], errors = [];

      rows.forEach((row, index) => {
        if (Object.values(row).every(v => !v || v.toString().trim() === '')) return;

        const rowErrors = [];
        const rowNum = index + 2;

        const country = countryKey ? row[countryKey]?.trim().toUpperCase() : 'IN';

        // Core contact/date checks
        if (phoneKey) {
          const r = validatePhone(row[phoneKey], country);
          if (!r.valid) rowErrors.push(`Phone: ${r.reason}`);
        }
        if (dateKey) {
          const r = validateDate(row[dateKey]);
          if (!r.valid) rowErrors.push(`Date: ${r.reason}`);
}
        if (emailKey) {
          const r = validateEmail(row[emailKey]);
          if (!r.valid) rowErrors.push(`Email: ${r.reason}`);
        }

        // Order-level checks
        const orderKeys = { orderIdKey, amountKey, quantityKey };
        if (orderIdKey || amountKey || quantityKey) {
          validateOrderFields(row, orderKeys).forEach(e => rowErrors.push(`Order: ${e}`));
        }

        // Product-level checks
        const productKeys = { productIdKey, productNameKey, priceKey };
        if (productIdKey || productNameKey || priceKey) {
          validateProductFields(row, productKeys).forEach(e => rowErrors.push(`Product: ${e}`));
        }

        // Payment mode check
        if (paymentKey) {
          const r = validatePaymentMode(row[paymentKey]);
          if (!r.valid) rowErrors.push(`Payment: ${r.reason}`);
        }

        if (rowErrors.length === 0) {
          validRows.push(row);
        } else {
          invalidRows.push({ ...row, errors: rowErrors.join(' | ') });
          errors.push({ row: rowNum, issues: rowErrors });
        }
      });

      const chunkSize = 100;
      const chunks = [];
      for (let i = 0; i < validRows.length; i += chunkSize)
        chunks.push(validRows.slice(i, i + chunkSize));

      res.json({
        total: validRows.length + invalidRows.length,
        valid: validRows.length,
        invalid: invalidRows.length,
        errors,
        validData: validRows,
        invalidData: invalidRows,
        chunks: chunks.length,
        detectedColumns,
      });
    })
    .on('error', err => res.status(500).json({ error: 'CSV parse error: ' + err.message }));
});

// ── DOWNLOAD ROUTES ────────────────────────────────────────────────────────
app.post('/download', (req, res) => {
  const { data, type } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'No data' });
  const csv = new Parser().parse(data);
  res.header('Content-Type', 'text/csv');
  res.attachment(`${type}_data.csv`);
  res.send(csv);
});

app.post('/download-chunk', (req, res) => {
  const { data, chunkIndex } = req.body;
  if (!data?.length) return res.status(400).json({ error: 'No data' });
  const csv = new Parser().parse(data);
  res.header('Content-Type', 'text/csv');
  res.attachment(`chunk_${chunkIndex + 1}.csv`);
  res.send(csv);
});

const PORT = process.env.PORT || 3000;
if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => console.log(`✓ Xeno Validator running → http://localhost:${PORT}`));
}

module.exports = app;