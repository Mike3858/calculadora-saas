require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { jsPDF } = require('jspdf');
require('jspdf-autotable');
const fs = require('fs').promises;
const path = require('path');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM;

const app = express();
const port = 3000;

const db = new sqlite3.Database('./leads.db', (err) => {
    if (err) {
        console.error("Erro ao abrir o banco de dados", err.message);
    } else {
        console.log("Conectado ao banco de dados.");
        db.run(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, whatsapp TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS pending_calculations (reference_id TEXT PRIMARY KEY, mp_preference_id TEXT, data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    }
});

const COMPLETED_DIR = path.join(__dirname, 'completed_pdfs');
fs.mkdir(COMPLETED_DIR, { recursive: true });

app.use(cors());
app.use(bodyParser.json());

const client = new MercadoPagoConfig({ accessToken: MERCADOPAGO_ACCESS_TOKEN });

app.post('/preview-calculation', (req, res) => {
    try {
        const results = calculateValues(req.body);
        res.json(results);
    } catch (error) {
        console.error("Erro no cálculo da prévia:", error);
        res.status(500).json({ message: "Não foi possível calcular os valores." });
    }
});

app.post('/create-payment', async (req, res) => {
    const calculationData = req.body;
    try {
        const uniqueReference = crypto.randomUUID();
        const preferenceBody = {
            items: [{ title: 'Cálculo de Rescisão Trabalhista Detalhado', quantity: 1, currency_id: 'BRL', unit_price: 29.90 }],
            payer: { email: calculationData.email },
            back_urls: { success: SITE_URL, failure: SITE_URL, pending: SITE_URL },
            auto_return: 'approved',
            notification_url: WEBHOOK_URL,
            external_reference: uniqueReference
        };
        const preference = new Preference(client);
        const response = await preference.create({ body: preferenceBody });
        const mpPreferenceId = response.id;
        const dataString = JSON.stringify(calculationData);
        db.run(`INSERT INTO pending_calculations (reference_id, mp_preference_id, data) VALUES (?, ?, ?)`, 
            [uniqueReference, mpPreferenceId, dataString], function(err) {
            if (err) {
                console.error("[CREATE_PAYMENT] Erro ao salvar dados pendentes no DB:", err.message);
                return res.status(500).json({ message: 'Erro ao guardar os dados do cálculo.' });
            }
            console.log(`[CREATE_PAYMENT] Dados do cálculo salvos no DB para a referência: ${uniqueReference}`);
            res.json({ init_point: response.init_point });
        });
    } catch (error) {
        console.error('[CREATE_PAYMENT] Erro ao criar preferência:', error?.cause ?? error);
        res.status(500).json({ message: error?.cause?.[0]?.description || 'Erro interno.' });
    }
});

app.post('/webhook', async (req, res) => {
    const notification = req.body;
    if (!notification || notification.type !== 'payment' || !notification.data || !notification.data.id) {
        return res.status(200).send('ok');
    }
    try {
        const paymentId = notification.data.id;
        const payment = new Payment(client);
        const paymentDetails = await payment.get({ id: paymentId });
        const externalReference = paymentDetails.external_reference;
        if (paymentDetails.status === 'approved' && externalReference) {
            db.get(`SELECT data, mp_preference_id FROM pending_calculations WHERE reference_id = ?`, [externalReference], async (err, row) => {
                if (err) return console.error("ERRO ao ler do DB no webhook:", err.message);
                if (row) {
                    const calcData = JSON.parse(row.data);
                    const preferenceIdForFile = row.mp_preference_id;
                    db.run(`INSERT INTO leads (name, email, whatsapp) VALUES (?, ?, ?)`,
                        [calcData.name, calcData.email, calcData.whatsapp], (err) => {
                        if (err) console.error("ERRO AO SALVAR LEAD:", err.message);
                        else console.log(`Lead salvo com sucesso!`);
                    });
                    const pdfArrayBuffer = await generatePDF(calcData);
                    const pdfBuffer = Buffer.from(pdfArrayBuffer);
                    const pdfPath = path.join(COMPLETED_DIR, `${preferenceIdForFile}.pdf`);
                    await fs.writeFile(pdfPath, pdfBuffer);
                    console.log(`PDF salvo em: ${pdfPath}`);
                    await sendCalculationEmail(calcData, pdfBuffer);
                    db.run(`DELETE FROM pending_calculations WHERE reference_id = ?`, externalReference);
                }
            });
        }
        res.status(200).send('ok');
    } catch (error) {
        console.error('--- ERRO CRÍTICO NO WEBHOOK ---:', error);
        res.status(500).send('Erro ao processar o webhook.');
    }
});

app.get('/status/:preferenceId', async (req, res) => {
    const { preferenceId } = req.params;
    const pdfPath = path.join(COMPLETED_DIR, `${preferenceId}.pdf`);
    try {
        await fs.access(pdfPath);
        res.json({ status: 'ready' });
    } catch {
        res.json({ status: 'pending' });
    }
});

app.get('/download/:preferenceId', (req, res) => {
    const { preferenceId } = req.params;
    const pdfPath = path.join(COMPLETED_DIR, `${preferenceId}.pdf`);
    res.download(pdfPath, 'calculo-rescisao-detalhado.pdf', (err) => {
        if (!err) fs.unlink(pdfPath);
    });
});

function calculateValues(data) {
    const salary = parseFloat(data['last-salary']) || 0;
    const startDate = new Date(data['start-date'] + 'T00:00:00');
    const endDate = new Date(data['end-date'] + 'T00:00:00');
    if (isNaN(startDate) || isNaN(endDate) || endDate < startDate) return {};
    const dailySalary = salary / 30;
    const daysInLastMonth = endDate.getDate();
    const saldoDeSalario = dailySalary * daysInLastMonth;
    const totalMonths = ((endDate.getFullYear() - startDate.getFullYear()) * 12) + (endDate.getMonth() - startDate.getMonth()) + (endDate.getDate() >= startDate.getDate() ? 1 : 0);
    const monthsFor13th = endDate.getDate() >= 15 ? endDate.getMonth() + 1 : endDate.getMonth();
    const decimoTerceiroProporcional = (salary / 12) * monthsFor13th;
    const numFeriasVencidas = parseInt(data['ferias-vencidas'], 10) || 0;
    const feriasVencidas = salary * numFeriasVencidas;
    const monthsForFerias = totalMonths % 12;
    const feriasProporcionais = (salary / 12) * monthsForFerias;
    const totalFerias = feriasProporcionais + feriasVencidas;
    const tercoConstitucional = totalFerias / 3;
    const avisoPrevioIndenizado = salary;
    const estimatedFGTSTotal = (salary * 0.08) * totalMonths;
    const multaFGTS = estimatedFGTSTotal * 0.40;
    const totalGeral = saldoDeSalario + decimoTerceiroProporcional + totalFerias + tercoConstitucional + avisoPrevioIndenizado + multaFGTS;
    return {
        'Saldo de Salário': saldoDeSalario, 'Aviso Prévio Indenizado': avisoPrevioIndenizado, '13º Salário Proporcional': decimoTerceiroProporcional,
        'Férias Vencidas': feriasVencidas, 'Férias Proporcionais': feriasProporcionais, '1/3 Constitucional sobre Férias': tercoConstitucional,
        'Multa de 40% do FGTS (Estimativa)': multaFGTS, 'TOTAL GERAL ESTIMADO': totalGeral
    };
}

async function generatePDF(data) {
    const calculationResults = calculateValues(data);
    const irregularities = data.irregularities || [];
    const doc = new jsPDF();
    doc.setFontSize(10);
    doc.text(`Cálculo para: ${data.name || 'Não informado'}`, 14, 15);
    doc.text(`E-mail: ${data.email}`, 14, 20);
    doc.text(`WhatsApp: ${data.whatsapp || 'Não informado'}`, 14, 25);
    doc.setFontSize(16);
    doc.text('Cálculo Detalhado de Rescisão Indireta', 105, 35, null, null, 'center');
    const tableColumn = ["Verba", "Valor (R$)"];
    const tableRows = [];
    Object.entries(calculationResults).forEach(([key, value]) => {
        if (value > 0 && key !== 'TOTAL GERAL ESTIMADO') {
            tableRows.push([key, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)]);
        }
    });
    tableRows.push(['TOTAL GERAL ESTIMADO', new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(calculationResults['TOTAL GERAL ESTIMADO'])]);
    doc.autoTable({ head: [tableColumn], body: tableRows, startY: 40, theme: 'striped',
        didDrawCell: (data) => {
            if (data.row.index === tableRows.length - 1) doc.setFont(undefined, 'bold');
        }
    });
    let finalY = doc.lastAutoTable.finalY;
    if (irregularities.length > 0) {
        doc.setFontSize(12);
        doc.text('Irregularidades Apontadas:', 14, finalY + 10);
        doc.setFontSize(10);
        doc.text(irregularities.map(item => `- ${item}`).join('\n'), 14, finalY + 16);
    }
    return doc.output('arraybuffer');
}

async function sendCalculationEmail(data, pdfBuffer) {
    if (!EMAIL_HOST || !EMAIL_USER || !EMAIL_PASS) {
        console.log("Credenciais de e-mail não configuradas. A saltar o envio de e-mail.");
        return;
    }
    const transporter = nodemailer.createTransport({
        host: EMAIL_HOST, port: EMAIL_PORT, secure: EMAIL_PORT == 465, auth: { user: EMAIL_USER, pass: EMAIL_PASS }
    });
    try {
        await transporter.sendMail({
            from: EMAIL_FROM, to: data.email, subject: 'Seu Cálculo de Rescisão Trabalhista está Pronto!',
            html: `<p>Olá, ${data.name || 'Cliente'}!</p><p>Obrigado por utilizar nossa calculadora. Seu cálculo detalhado e desbloqueado está em anexo.</p><p>Atenciosamente,<br>Equipe da Calculadora</p>`,
            attachments: [{ filename: 'calculo-rescisao-detalhado.pdf', content: Buffer.from(pdfBuffer), contentType: 'application/pdf' }]
        });
        console.log('E-mail de backup enviado com sucesso para:', data.email);
    } catch (error) {
        console.error('ERRO AO ENVIAR E-MAIL:', error);
    }
}

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(port, () => {
    console.log(`Servidor da calculadora a rodar na porta ${port}`);
});
