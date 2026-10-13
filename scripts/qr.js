// Show a QR code for a URL so a phone can open ClipForge by scanning it.
//   node scripts/qr.js <url>               → prints it in the terminal
//   node scripts/qr.js <url> --png <file>  → also saves a PNG (for terminals without colour support)
import QRCode from 'qrcode';

const [url, flag, file] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/qr.js <url> [--png <file>]');
  process.exit(1);
}
console.log(await QRCode.toString(url, { type: 'terminal', small: true, errorCorrectionLevel: 'M' }));
if (flag === '--png' && file) await QRCode.toFile(file, url, { width: 480, margin: 2 });
