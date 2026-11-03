const selfsigned = require('selfsigned');
const fs = require('fs');
const os = require('os');
const path = require('path');

// selfsigned v5 mengembalikan Promise (bukan callback lagi)
async function main() {
    const ips = Object.values(os.networkInterfaces()).flat()
        .filter(i => i && i.family === 'IPv4' && !i.internal)
        .map(i => i.address);

    const altNames = [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        ...ips.map(ip => ({ type: 7, ip }))
    ];

    const pems = await selfsigned.generate(
        [{ name: 'commonName', value: 'localhost' }],
        { days: 365, keySize: 2048, extensions: [{ name: 'subjectAltName', altNames }] }
    );

    const sslDir = path.join(__dirname, 'ssl');
    fs.mkdirSync(sslDir, { recursive: true });
    fs.writeFileSync(path.join(sslDir, 'key.pem'), pems.private);
    fs.writeFileSync(path.join(sslDir, 'cert.pem'), pems.cert);
    console.log('Sertifikat SSL berhasil dibuat di folder ssl/!');
}

main().catch(err => {
    console.error('Gagal membuat SSL:', err);
    process.exit(1);
});