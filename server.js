const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { jsPDF } = require('jspdf');
require('jspdf-autotable');
const fs = require('fs').promises;
const path = require('path'); // Adicionado para lidar com caminhos de arquivo
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// ==================== CONFIGURAÇÃO ====================
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://calculotrabalhista.mbbaj.adv.br/webhook';
const PORT = process.env.PORT || 3000;

// ==================== VERIFICAÇÃO ====================
console.log('=== 🔧 INICIANDO SERVIDOR ===');
console.log(`✅ Porta definida: ${PORT}`);
console.log('✅ Token MP:', MERCADOPAGO_ACCESS_TOKEN ? 'PRESENTE' : 'AUSENTE');
console.log('✅ Webhook URL:', WEBHOOK_URL);

if (!MERCADOPAGO_ACCESS_TOKEN) {
    console.error('❌ ERRO CRÍTICO: MERCADOPAGO_ACCESS_TOKEN não configurado!');
    process.exit(1);
}

// ==================== CONFIGURAÇÃO MERCADO PAGO V2 ====================
const client = new MercadoPagoConfig({
    accessToken: MERCADOPAGO_ACCESS_TOKEN,
    options: { timeout: 15000 }
});

const app = express();

// ==================== BANCO DE DADOS ====================
const dbPath = path.join(__dirname, 'leads.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('❌ Erro no banco:', err.message); } 
    else {
        console.log('✅ Banco de dados conectado!');
        db.run(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, whatsapp TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        db.run(`CREATE TABLE IF NOT EXISTS pending_calculations (reference_id TEXT PRIMARY KEY, mp_preference_id TEXT, data TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    }
});
const COMPLETED_DIR = path.join(__dirname, 'completed_pdfs');
fs.mkdir(COMPLETED_DIR, { recursive: true }).catch(console.error);

// ==================== MIDDLEWARES ====================
app.use(cors());
app.use(bodyParser.json());
// Serve os arquivos estáticos (como CSS ou imagens no futuro)
app.use(express.static(__dirname));

// ==================== ROTAS ====================

// ROTA PRINCIPAL PARA SERVIR O index.html (CORREÇÃO DO 404)
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/preview-calculation', (req, res) => {
    try {
        const results = calculateValues(req.body);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: 'Erro no cálculo' });
    }
});

app.post('/create-payment', async (req, res) => {
    // ... (O resto do seu código permanece exatamente o mesmo)
    // (Apenas colei o resto aqui para garantir que você tenha o arquivo completo)
    console.log('💰 SOLICITAÇÃO DE PAGAMENTO V2 RECEBIDA');
    try {
        const calculationData = req.body;
        const uniqueReference = crypto.randomUUID();
        const preference = new Preference(client);
        console.log('🔄 Criando preferência V2 no Mercado Pago...');
        const response = await preference.create({
            body: {
                items: [{ title: 'Cálculo de Rescisão Trabalhista Detalhado', quantity: 1, currency_id: 'BRL', unit_price: 29.90 }],
                payer: { email: calculationData.email, name: calculationData.name || 'Cliente' },
                back_urls: {
                    success: `${process.env.SITE_URL || 'http://localhost:3000'}?status=approved`,
                    failure: `${process.env.SITE_URL || 'http://localhost:3000'}?status=failure`,
                    pending: `${process.env.SITE_URL || 'http://localhost:3000'}?status=pending`
                },
                notification_url: WEBHOOK_URL,
                external_reference: uniqueReference
            }
        });
        console.log('✅ PREFERÊNCIA CRIADA COM SUCESSO!');
        const dataString = JSON.stringify(calculationData);
        db.run( `INSERT INTO pending_calculations (reference_id, mp_preference_id, data) VALUES (?, ?, ?)`,
            [uniqueReference, response.id, dataString],
            (err) => {
                if (err) {
                    console.error('❌ Erro no banco ao salvar pendência:', err.message);
                    return res.status(500).json({ error: 'Erro interno' });
                }
                console.log('💾 Dados salvos. Referência:', uniqueReference);
                res.json({ init_point: response.init_point });
            }
        );
    } catch (error) {
        console.error('❌ ERRO AO CRIAR PAGAMENTO V2:', error);
        res.status(500).json({ error: 'Erro ao criar pagamento', message: error.message });
    }
});

app.post('/webhook', async (req, res) => {
    console.log('📨 WEBHOOK RECEBIDO');
    try {
        const { type, data } = req.body;
        if (type === 'payment' && data?.id) {
            console.log('💳 Processando pagamento ID:', data.id);
            const payment = new Payment(client);
            const paymentDetails = await payment.get({ id: data.id });
            console.log('📊 Status do pagamento:', paymentDetails.status);
            if (paymentDetails.status === 'approved' && paymentDetails.external_reference) {
                console.log('✅ PAGAMENTO APROVADO!');
                await processApprovedPayment(paymentDetails.external_reference, paymentDetails);
            }
        }
        res.status(200).send('OK');
    } catch (error) {
        console.error('❌ ERRO NO WEBHOOK:', error);
        res.status(500).send('Erro');
    }
});

// ... (O resto do seu código, como processApprovedPayment, calculateValues, etc., permanece aqui)
async function processApprovedPayment(externalReference, paymentDetails) {
    return new Promise((resolve, reject) => {
        db.get( `SELECT data, mp_preference_id FROM pending_calculations WHERE reference_id = ?`, [externalReference],
            async (err, row) => {
                if (err) return reject(err);
                if (!row) {
                    console.log('⚠️ Referência não encontrada:', externalReference);
                    return resolve();
                }
                try {
                    const calcData = JSON.parse(row.data);
                    db.run(`INSERT INTO leads (name, email, whatsapp) VALUES (?, ?, ?)`, [calcData.name, calcData.email, calcData.whatsapp]);
                    const pdfBuffer = await generatePDF(calcData);
                    const pdfPath = path.join(COMPLETED_DIR, `${row.mp_preference_id}.pdf`);
                    await fs.writeFile(pdfPath, pdfBuffer);
                    console.log('📄 PDF gerado:', pdfPath);
                    db.run(`DELETE FROM pending_calculations WHERE reference_id = ?`, [externalReference]);
                    resolve();
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}
app.get('/status/:preferenceId', async (req, res) => {
    try {
        const pdfPath = path.join(COMPLETED_DIR, `${req.params.preferenceId}.pdf`);
        await fs.access(pdfPath);
        res.json({ status: 'ready' });
    } catch {
        res.json({ status: 'pending' });
    }
});
app.get('/download/:preferenceId', (req, res) => {
    const pdfPath = path.join(COMPLETED_DIR, `${req.params.preferenceId}.pdf`);
    res.download(pdfPath, 'calculo-rescisao-detalhado.pdf');
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
    return { 'Saldo de Salário': saldoDeSalario, 'Aviso Prévio Indenizado': avisoPrevioIndenizado, '13º Salário Proporcional': decimoTerceiroProporcional, 'Férias Vencidas': feriasVencidas, 'Férias Proporcionais': feriasProporcionais, '1/3 Constitucional sobre Férias': tercoConstitucional, 'Multa de 40% do FGTS (Estimativa)': multaFGTS, 'TOTAL GERAL ESTIMADO': totalGeral };
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
        if (value > 0) { tableRows.push([key, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)]); }
    });
    doc.autoTable({ head: [tableColumn], body: tableRows, startY: 40, theme: 'striped', didDrawCell: (data) => { if (data.row.index === tableRows.length - 1) { doc.setFont(undefined, 'bold'); } } });
    let finalY = doc.lastAutoTable.finalY + 10;
    if (irregularities.length > 0) {
        doc.setFontSize(12);
        doc.text('Irregularidades Apontadas:', 14, finalY);
        doc.setFontSize(10);
        irregularities.forEach((item, index) => { doc.text(`- ${item}`, 14, finalY + 5 + (index * 5)); });
    }
    return doc.output('arraybuffer');
}

// ==================== INICIAR SERVIDOR ====================
app.listen(PORT, () => {
    console.log(`🚀 SERVIDOR INICIADO NA PORTA ${PORT}`);
});