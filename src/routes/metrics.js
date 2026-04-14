import express from 'express';
import { metricsService } from '../services/metricsService.js';
import { authMiddleware } from '../middleware/authMiddleware.js';

const router = express.Router();

// Middleware común para extraer fechas de query params
const parseDates = (req, res, next) => {
    const NOW = new Date();
    const THIRTY_DAYS_AGO = new Date(NOW.getTime() - (30 * 24 * 60 * 60 * 1000));

    req.query.startDate = req.query.startDate || THIRTY_DAYS_AGO.toISOString();
    req.query.endDate = req.query.endDate || NOW.toISOString();
    next();
};

// GET /api/metrics/overview
router.get('/overview', authMiddleware, parseDates, async (req, res) => {
    try {
        // Asumimos que authMiddleware pone el user en req.user
        // y que el store_id está disponible en el perfil del usuario.
        // Si no, habría que pasarlo o inferirlo.
        // Aquí asumiré que el ADMIN o MANAGER tiene un `store_id` en su perfil.
        const storeId = req.user.store_id; 

        if (!storeId) {
            return res.status(400).json({ error: 'Usuario no asociado a una tienda.' });
        }

        const stats = await metricsService.getSalesOverview(
            storeId, 
            req.query.startDate, 
            req.query.endDate
        );
        res.json(stats);
    } catch (error) {
        console.error('Error fetching overview:', error);
        res.status(500).json({ error: 'Error interno obteniendo métricas generales.' });
    }
});

// GET /api/metrics/sales-by-day
router.get('/sales-by-day', authMiddleware, parseDates, async (req, res) => {
    try {
        const storeId = req.user.store_id;
        if (!storeId) return res.status(400).json({ error: 'No store ID' });

        const data = await metricsService.getSalesByDay(
            storeId, 
            req.query.startDate, 
            req.query.endDate
        );
        res.json(data);
    } catch (error) {
        console.error('Error fetching sales by day:', error);
        res.status(500).json({ error: 'Error obteniendo historial de ventas.' });
    }
});

// GET /api/metrics/top-products
router.get('/top-products', authMiddleware, async (req, res) => {
    try {
        const storeId = req.user.store_id;
        if (!storeId) return res.status(400).json({ error: 'No store ID' });

        const data = await metricsService.getTopProducts(storeId);
        res.json(data);
    } catch (error) {
        console.error('Error fetching top products:', error);
        res.status(500).json({ error: 'Error obteniendo mejores productos.' });
    }
});

// GET /api/metrics/conversion
router.get('/conversion', authMiddleware, parseDates, async (req, res) => {
    try {
        const storeId = req.user.store_id;
        if (!storeId) return res.status(400).json({ error: 'No store ID' });

        const data = await metricsService.getConversionRate(
            storeId, 
            req.query.startDate, 
            req.query.endDate
        );
        res.json(data);
    } catch (error) {
        console.error('Error fetching conversion:', error);
        res.status(500).json({ error: 'Error calculando tasa de conversión.' });
    }
});

// GET /api/metrics/abandoned-carts
router.get('/abandoned-carts', authMiddleware, async (req, res) => {
    try {
        const storeId = req.user.store_id;
        if (!storeId) return res.status(400).json({ error: 'No store ID' });

        const data = await metricsService.getAbandonedCarts(storeId);
        res.json(data);
    } catch (error) {
        console.error('Error fetching abandoned carts:', error);
        res.status(500).json({ error: 'Error obteniendo carritos abandonados.' });
    }
});

export default router;
