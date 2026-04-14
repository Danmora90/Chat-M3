import { supabaseAdmin } from './supabase.js';

class MetricsService {
    /**
     * Obtiene el resumen general de ventas (Total, Cantidad, Ticket Promedio)
     * @param {string} storeId 
     * @param {string} startDate (ISO String)
     * @param {string} endDate (ISO String)
     */
    async getSalesOverview(storeId, startDate, endDate) {
        // 🔴 ENFORCING: Use payment_verified = true ONLY. 
        // We need both count (for orders) and data (for revenue sum).
        let query = supabaseAdmin
            .from('ai_sales')
            .select('total_amount', { count: 'exact' }) 
            .eq('store_id', storeId)
            .eq('payment_verified', true);

        if (startDate) query = query.gte('created_at', startDate);
        if (endDate) query = query.lte('created_at', endDate);

        const { data, count, error } = await query;

        if (error) {
            console.error('[Metrics] Error fetching sales overview:', error);
            throw error;
        }

        const safeData = data || [];
        const totalSales = safeData.reduce((sum, sale) => sum + (Number(sale.total_amount) || 0), 0);
        
        // 🔴 Total Orders: Use the count returned by Supabase
        const totalOrders = (count !== null && count !== undefined) ? count : safeData.length;

        // 🔴 Avg Ticket: SUM(total_amount) / COUNT(*)
        const averageTicket = totalOrders > 0 ? totalSales / totalOrders : 0;

        // VALIDACIÓN INTERNA REQUERIDA
        console.log('--- DEBUG getSalesOverview ---');
        console.log('Store ID:', storeId);
        console.log('Date Range:', startDate, 'to', endDate);
        console.log('Orders Count (DB):', count);
        console.log('Data Length:', safeData.length);
        console.log('Total Revenue (Calc):', totalSales);
        console.log('Final Total Orders:', totalOrders);
        console.log('--- END DEBUG ---');

        return {
            total_orders: totalOrders,
            total_revenue: totalSales,
            avg_ticket: averageTicket
        };
    }

    /**
     * Obtiene ventas agrupadas por día para gráficas
     */
    async getSalesByDay(storeId, startDate, endDate) {
        let query = supabaseAdmin
            .from('ai_sales')
            .select('created_at, total_amount')
            .eq('store_id', storeId)
            .eq('payment_verified', true)
            .order('created_at', { ascending: true });

        if (startDate) query = query.gte('created_at', startDate);
        if (endDate) query = query.lte('created_at', endDate);

        const { data, error } = await query;
        if (error) throw error;

        // Agrupación JS
        const grouped = {};
        
        data.forEach(sale => {
            const dateStr = new Date(sale.created_at).toISOString().split('T')[0]; // YYYY-MM-DD
            if (!grouped[dateStr]) {
                grouped[dateStr] = { day: dateStr, total_sales: 0 };
            }
            grouped[dateStr].total_sales += Number(sale.total_amount);
        });

        // Retornar array ordenado por fecha
        return Object.values(grouped).sort((a, b) => new Date(a.day) - new Date(b.day));
    }

    /**
     * Obtiene los productos más vendidos
     */
    async getTopProducts(storeId, limit = 5) {
        // Obtenemos todos los items de ventas verificadas
        const { data, error } = await supabaseAdmin
            .from('ai_sale_items')
            .select(`
                quantity,
                subtotal,
                product_id,
                ai_sales!inner(store_id, payment_verified),
                products(name)
            `)
            .eq('ai_sales.store_id', storeId)
            .eq('ai_sales.payment_verified', true);

        if (error) throw error;

        // Agrupación y Sumas en JS
        const productStats = {};

        data.forEach(item => {
            const productName = item.products?.name || 'Producto Desconocido';
            // Usamos nombre como clave para agrupar por nombre (como sugiere el usuario), 
            // aunque product_id sería más robusto. 
            // Si hay productos con mismo nombre pero diferente ID, se agruparán aquí.
            if (!productStats[productName]) {
                productStats[productName] = {
                    product_name: productName,
                    units_sold: 0,
                    revenue: 0
                };
            }
            productStats[productName].units_sold += item.quantity;
            // Aseguramos que subtotal sea numérico
            productStats[productName].revenue += Number(item.subtotal) || 0;
        });

        // Ordenar por unidades vendidas DESC y Limitar
        return Object.values(productStats)
            .sort((a, b) => b.units_sold - a.units_sold)
            .slice(0, limit);
    }

    /**
     * Compara ventas vs intentos totales (utilizando chats totales como proxy de intención)
     * MVP: 
     * conversion_rate = (Ventas Verificadas / Total Chats) * 100
     */
    async getConversionRate(storeId, startDate, endDate) {
        // 1. Total Ventas Verificadas (Numerador)
        let salesQuery = supabaseAdmin
            .from('ai_sales')
            .select('*', { count: 'exact', head: true })
            .eq('store_id', storeId)
            .eq('payment_verified', true);

        if (startDate) salesQuery = salesQuery.gte('created_at', startDate);
        if (endDate) salesQuery = salesQuery.lte('created_at', endDate);

        const { count: salesCount, error: salesError } = await salesQuery;
        if (salesError) throw salesError;

        // 2. Total Conversaciones/Chats (Denominador - "Intentos")
        // Usamos la tabla `chats` para tener el universo total de interacciones
        let chatsQuery = supabaseAdmin
            .from('chats')
            .select('*', { count: 'exact', head: true })
            .eq('store_id', storeId);
            
        if (startDate) chatsQuery = chatsQuery.gte('created_at', startDate);
        
        const { count: totalChats, error: chatsError } = await chatsQuery;
        if (chatsError) throw chatsError;

        // Cálculo porcentaje
        const rate = totalChats > 0 ? (salesCount / totalChats) * 100 : 0;

        return {
            conversion_rate: parseFloat(rate.toFixed(2)),
            sales_count: salesCount,
            total_chats: totalChats
        };
    }

    /**
     * Devuelve detalle de carritos abandonados
     */
    async getAbandonedCarts(storeId) {
        // Obtener items y agrupar por chat
        const { data, error } = await supabaseAdmin
            .from('chat_cart_items')
            .select(`
                chat_id,
                quantity,
                unit_price,
                created_at,
                products(name),
                chats(user_id, users(display_name, phone_number))
            `)
            .eq('store_id', storeId)
            .order('created_at', { ascending: false });

        if (error) throw error;

        // Agrupar por Chat
        const carts = {};
        
        data.forEach(item => {
            const cid = item.chat_id;
            if (!carts[cid]) {
                carts[cid] = {
                    chatId: cid,
                    customerName: item.chats?.users?.display_name || 'Anónimo',
                    customerPhone: item.chats?.users?.phone_number || 'Desconocido',
                    lastUpdate: item.created_at,
                    totalPotential: 0,
                    itemCount: 0,
                    items: []
                };
            }
            
            const subtotal = item.quantity * item.unit_price;
            carts[cid].totalPotential += subtotal;
            carts[cid].itemCount += 1; // items distinct
            carts[cid].items.push({
                product: item.products?.name,
                quantity: item.quantity,
                price: item.unit_price,
                subtotal
            });
        });

        return Object.values(carts);
    }
}

export const metricsService = new MetricsService();
