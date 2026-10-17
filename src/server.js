import dotenv from 'dotenv';
// Cargar variables de entorno antes de cualquier otro import
dotenv.config();

import express from 'express';
import cors from 'cors';
import webhookRoutes from './routes/webhook.js';
import metaWebhookRoutes from './routes/metaWebhook.js';
import apiRoutes from './routes/api.js';
import crmRoutes from './routes/crm.js';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import metricsRoutes from './routes/metrics.js';
import taskRoutes from './routes/tasks.js';
import notificationRoutes from './routes/notifications.js';
import maschatRoutes from './routes/maschat.js';
import templateRoutes from './routes/templates.js';
import automationsRoutes from './routes/automations.js';
import { startAutomationWorker } from './jobs/automationWorker.js';
import { createRateLimiter } from './middleware/rateLimiter.js';
import { logger, requestLogger } from './middleware/logger.js';
import { errorHandler } from './utils/errors.js';

const app = express();
const PORT = process.env.PORT || 3010;

// Confiar en el proxy inverso (Railway, Docker) para encabezados x-forwarded-*
app.set('trust proxy', 1);

// Configuración CORS
const allowedOrigins = process.env.FRONTEND_URLS?.split(',').map(url => url.trim()) || [
    'http://localhost:5173',
    'http://localhost:3001',
    'http://localhost:3000',
    'http://localhost:3011'
];

app.use(cors({
    origin: (origin, callback) => {
        // Permitir requests sin origin (como mobile apps o curl)
        if (!origin) return callback(null, true);

        if (allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            logger.warn('CORS blocked request', { origin });
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
}));

// Middleware global
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Rate limiting
app.use(createRateLimiter());

// Routes
app.use('/m3', webhookRoutes);
app.use('/webhook', webhookRoutes); // Alias para soportar tanto /m3/whatsapp como /webhook/whatsapp
app.use('/m3/meta', metaWebhookRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin/templates', templateRoutes);
app.use('/api/admin/automations', automationsRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/maschat', maschatRoutes);
app.use('/auth', authRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        service: 'whatsapp-ai-assistant',
        version: '1.0.0'
    });
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'WhatsApp AI Assistant API',
        version: '1.0.0',
        endpoints: {
            health: '/health',
            webhook: '/m3/whatsapp'
        }
    });
});

// 404 handler
app.use((req, res) => {
    logger.warn('Endpoint not found', {
        method: req.method,
        path: req.path,
        url: req.url,
        ip: req.ip
    });
    res.status(404).json({ error: 'Endpoint not found' });
});

// Error handler (debe ir al final)
app.use(errorHandler);

// Iniciar servidor
app.listen(PORT, () => {
    logger.info(`Server started on port ${PORT}`, {
        environment: process.env.NODE_ENV,
        port: PORT
    });
    console.log(`\n🚀 WhatsApp AI Assistant Server`);
    console.log(`📍 Running on: http://localhost:${PORT}`);
    console.log(`🏥 Health check: http://localhost:${PORT}/health`);
    console.log(`📱 Webhook: http://localhost:${PORT}/m3/whatsapp\n`);

    // Iniciar worker de automatizaciones en segundo plano (cada 60 segundos)
    startAutomationWorker(60);
});

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', { error: error.message, stack: error.stack });
    process.exit(1);
});

export default app;
