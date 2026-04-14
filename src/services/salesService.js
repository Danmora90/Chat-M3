import { supabaseAdmin } from './supabase.js';

class SalesService {
    /**
     * Verifica y registra una venta procesando el pago y moviendo items del carrito.
     * Utiliza una RPC (función SQL) para atomicidad.
     * 
     * @param {string} chatId - ID del chat
     * @param {number} verifiedAmount - Monto detectado en el comprobante/confirmado
     * @param {string} paymentMethod - Método de pago (Nequi, Daviplata, Efectivo, etc)
     */
    async verifyAndRegisterSale(chatId, verifiedAmount, paymentMethod = 'unknown') {
        try {
            console.log(`[SalesService] Attempting to register sale for chat ${chatId}. Amount: ${verifiedAmount}`);

            // 1. Recuperar store_id explícitamente para garantizar integridad
            const { data: chat, error: chatError } = await supabaseAdmin
                .from('chats')
                .select('store_id')
                .eq('id', chatId)
                .single();

            if (chatError || !chat) {
                console.error('[SalesService] Could not resolve store_id from chat:', chatError);
                // No abortamos aquí, permitimos que el RPC intente usar el del carrito, 
                // pero pasaremos null como fallback explícito.
            }

            const forcedStoreId = chat?.store_id || null;

            // Llamar a la RPC 'register_sale' actualizada con el parámetro extra
            const { data, error } = await supabaseAdmin.rpc('register_sale', {
                p_chat_id: chatId,
                p_total_verified: verifiedAmount,
                p_payment_method: paymentMethod,
                p_forced_store_id: forcedStoreId
            });

            if (error) {
                console.error('[SalesService] RPC Error:', error);
                throw new Error(`Error en base de datos: ${error.message}`);
            }

            if (!data.success) {
                console.warn('[SalesService] Sale rejected by RPC:', data.message);
                return { 
                    success: false, 
                    message: data.message 
                };
            }

            console.log('[SalesService] Sale registered successfully:', data.sale_id, 'Code:', data.order_code);
            return {
                success: true,
                saleId: data.sale_id,
                orderCode: data.order_code, // Usar el código real retornado por DB
                message: "Venta registrada correctamente."
            };

        } catch (error) {
            console.error('[SalesService] Unexpected error:', error);
            throw error;
        }
    }

    /**
     * Verifica si ya existe una venta reciente (últimos 5 min) para evitar duplicados accidentales
     * (Opcional, lógica defensiva adicional)
     */
    async checkRecentSales(chatId) {
       const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
       
       const { data, error } = await supabaseAdmin
         .from('ai_sales')
         .select('id, created_at')
         .eq('chat_id', chatId)
         .gt('created_at', fiveMinutesAgo)
         .limit(1);

        if (error) return false;
        return data && data.length > 0;
    }

    /**
     * Obtiene el historial de ventas paginado con filtrado por tienda
     * Garantiza el contrato de respuesta con data y pagination.
     */
    async getSales({ storeId, page = 1, pageSize = 10 }) {
        try {
            const from = (page - 1) * pageSize;
            const to = from + pageSize - 1;

            // 1. Query principal con conteo
            let query = supabaseAdmin
                .from('ai_sales')
                .select(`
                    *,
                    ai_sale_items (
                        quantity,
                        unit_price,
                        subtotal,
                        products (name)
                    ),
                    users (display_name, phone_number)
                `, { count: 'exact' })
                .eq('store_id', storeId)
                .order('created_at', { ascending: false })
                .range(from, to);

            const { data, count, error } = await query;

            if (error) throw error;

            // Transformar respuesta: aplanar users a customer_* y definir status
            const sales = (data || []).map(sale => {
                // Prioridad: display_name > phone_number > Default
                const custName = sale.users?.display_name || sale.users?.phone_number || 'Cliente WhatsApp';
                const custPhone = sale.users?.phone_number || 'N/A';
                
                return {
                    ...sale,
                    customer_name: custName,
                    customer_phone: custPhone,
                    status: sale.payment_verified ? 'completed' : 'pending', // Mapeo lógico
                };
            });

            return {
                data: sales,
                pagination: {
                    page: Number(page),
                    pageSize: Number(pageSize),
                    total: count || 0
                }
            };
        } catch (error) {
            console.error('Error fetching sales:', error);
            throw error;
        }
    }
}

export const salesService = new SalesService();
