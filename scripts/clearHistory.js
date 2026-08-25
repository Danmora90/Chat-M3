import dotenv from 'dotenv';
dotenv.config();
import { createClient } from '@supabase/supabase-js';

async function clearHistory() {
    try {
        console.log('🧹 Limpiando memoria e historial de la IA...');
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
        
        const { error } = await supabase.from('checkpoints').delete().neq('thread_id', '');
        
        if (error) {
            console.error('❌ Error al borrar checkpoints:', error.message);
        } else {
            console.log('✅ ¡Memoria del agente limpiada con éxito! Ahora el agente iniciará conversaciones 100% desde cero.');
        }
    } catch (err) {
        console.error('❌ Error ejecutando script:', err.message);
    }
}

clearHistory();
