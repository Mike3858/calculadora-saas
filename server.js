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

// ==================== CONFIGURAÇÃO ====================
const MERCADOPAGO_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN;
const SITE_URL = process.env.SITE_URL || 'https://calculotrabalhista.mbbaj.adv.br';
const WEBHOOK_URL = process.env.WEBHOOK_URL || 'https://calculotrabalhista.mbbaj.adv.br/webhook';
const EMAIL_HOST = process.env.EMAIL_HOST;
const EMAIL_PORT = process.env.EMAIL_PORT;
const EMAIL_USER = process.env.EMAIL_USER;
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_FROM = process.env.EMAIL_FROM;

// ==================== VERIFICAÇÃO ====================
console.log('=== 🔧 INICIANDO SERVIDOR ===');
console.log('✅ Porta: 3000');
console.log('✅ Token MP:', MERCADOPAGO_ACCESS_TOKEN ? 'PRESENTE' : 'AUSENTE');
console.log('✅ Site URL:', SITE_URL);
console.log('✅ Webhook URL:', WEBHOOK_URL);

if (!MERCADOPAGO_ACCESS_TOKEN) {
    console.error('❌ ERRO CRÍTICO: Token não configurado!');
    console.error('💡 Configure MERCADOPAGO_ACCESS_TOKEN no Portainer');
    process.exit(1);
}

// ==================== CLIENTE MERCADO PAGO ====================
console.log('🔄 Configurando cliente Mercado Pago...');
const client = new MercadoPagoConfig({ 
    accessToken: MERCADOPAGO_ACCESS_TOKEN,
    options: { timeout: 15000 }
});

console.log('✅ Cliente Mercado Pago configurado!');

const app = express();
const port = 3000;

// ==================== BANCO DE DADOS ====================
console.log('🔄 Iniciando banco de dados...');
const db = new sqlite3.Database('./leads.db', (err) => {
    if (err) {
        console.error('❌ Erro no banco:', err.message);
    } else {
        console.log('✅ Banco de dados conectado!');
        db.run(`CREATE TABLE IF NOT EXISTS leads (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            name TEXT, 
            email TEXT, 
            whatsapp TEXT, 
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        db.run(`CREATE TABLE IF NOT EXISTS pending_calculations (
            reference_id TEXT PRIMARY KEY, 
            mp_preference_id TEXT, 
            data TEXT, 
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    }
});

const COMPLETED_DIR = path.join(__dirname, 'completed_pdfs');
fs.mkdir(COMPLETED_DIR, { recursive: true }).then(() => {
    console.log('✅ Pasta de PDFs criada!');
}).catch(console.error);

// ==================== MIDDLEWARES ====================
app.use(cors());
app.use(bodyParser.json());

// ==================== ROTAS ====================
app.post('/preview-calculation', (req, res) => {
    try {
        console.log('📊 Recebido cálculo preview');
        const results = calculateValues(req.body);
        res.json(results);
    } catch (error) {
        console.error('❌ Erro no preview:', error);
        res.status(500).json({ error: 'Erro no cálculo' });
    }
});

app.post('/create-payment', async (req, res) => {
    console.log('💰 SOLICITAÇÃO DE PAGAMENTO RECEBIDA');
    
    try {
        const calculationData = req.body;
        const uniqueReference = crypto.randomUUID();
        
        const preferenceBody = {
            items: [{ 
                title: 'Cálculo de Rescisão Trabalhista Detalhado', 
                quantity: 1, 
                currency_id: 'BRL', 
                unit_price: 29.90 
            }],
            payer: { 
                email: calculationData.email,
                name: calculationData.name || 'Cliente'
            },
            back_urls: { 
                success: `${SITE_URL}?status=approved&preference_id={preference_id}`,
                failure: `${SITE_URL}?status=failure`,
                pending: `${SITE_URL}?status=pending`
            },
            auto_return: 'approved',
            notification_url: WEBHOOK_URL,
            external_reference: uniqueReference
        };
        
        console.log('🔄 Criando preferência no Mercado Pago...');
        
        const preference = new Preference(client);
        const response = await preference.create({ body: preferenceBody });
        
        console.log('✅ PREFERÊNCIA CRIADA COM SUCESSO!');
        console.log('📋 Preference ID:', response.id);
        
        const dataString = JSON.stringify(calculationData);
        db.run(
            `INSERT INTO pending_calculations (reference_id, mp_preference_id, data) VALUES (?, ?, ?)`, 
            [uniqueReference, response.id, dataString],
            function(err) {
                if (err) {
                    console.error('❌ Erro no banco:', err.message);
                    return res.status(500).json({ error: 'Erro interno' });
                }
                
                console.log('💾 Dados salvos. Referência:', uniqueReference);
                
                res.json({ 
                    success: true,
                    init_point: response.init_point,
                    sandbox_init_point: response.sandbox_init_point || response.init_point,
                    preference_id: response.id
                });
            }
        );
        
    } catch (error) {
        console.error('❌ ERRO AO CRIAR PAGAMENTO:', error);
        
        res.status(500).json({ 
            error: 'Erro ao criar pagamento',
            message: error.message 
        });
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

async function processApprovedPayment(externalReference, paymentDetails) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT data, mp_preference_id FROM pending_calculations WHERE reference_id = ?`,
            [externalReference],
            async (err, row) => {
                if (err) {
                    console.error('❌ Erro no banco:', err);
                    return reject(err);
                }
                
                if (!row) {
                    console.log('⚠️ Referência não encontrada:', externalReference);
                    return resolve();
                }
                
                try {
                    const calcData = JSON.parse(row.data);
                    
                    // Salvar lead
                    db.run(
                        `INSERT INTO leads (name, email, whatsapp) VALUES (?, ?, ?)`,
                        [calcData.name, calcData.email, calcData.whatsapp]
                    );
                    
                    // Gerar PDF
                    const pdfBuffer = await generatePDF(calcData);
                    const pdfPath = path.join(COMPLETED_DIR, `${row.mp_preference_id}.pdf`);
                    await fs.writeFile(pdfPath, pdfBuffer);
                    
                    console.log('📄 PDF gerado:', pdfPath);
                    
                    // Limpar pendência
                    db.run(`DELETE FROM pending_calculations WHERE reference_id = ?`, [externalReference]);
                    
                    resolve();
                    
                } catch (error) {
                    console.error('❌ Erro no processamento:', error);
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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== FUNÇÕES AUXILIARES ====================
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
        'Saldo de Salário': saldoDeSalario,
        'Aviso Prévio Indenizado': avisoPrevioIndenizado,
        '13º Salário Proporcional': decimoTerceiroProporcional,
        'Férias Vencidas': feriasVencidas,
        'Férias Proporcionais': feriasProporcionais,
        '1/3 Constitucional sobre Férias': tercoConstitucional,
        'Multa de 40% do FGTS (Estimativa)': multaFGTS,
        'TOTAL GERAL ESTIMADO': totalGeral
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
        if (value > 0) {
            tableRows.push([key, new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)]);
        }
    });
    
    doc.autoTable({
        head: [tableColumn],
        body: tableRows,
        startY: 40,
        theme: 'striped',
        didDrawCell: (data) => {
            if (data.row.index === tableRows.length - 1) {
                doc.setFont(undefined, 'bold');
            }
        }
    });
    
    let finalY = doc.lastAutoTable.finalY + 10;
    
    if (irregularities.length > 0) {
        doc.setFontSize(12);
        doc.text('Irregularidades Apontadas:', 14, finalY);
        doc.setFontSize(10);
        irregularities.forEach((item, index) => {
            doc.text(`- ${item}`, 14, finalY + 5 + (index * 5));
        });
    }
    
    return doc.output('arraybuffer');
}

// ==================== INICIAR SERVIDOR ====================
app.listen(port, () => {
    console.log('=========================================');
    console.log('🚀 SERVIDOR INICIADO COM SUCESSO!');
    console.log('📍 Porta:', port);
    console.log('=========================================');
});