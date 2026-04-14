import { BaseCheckpointSaver } from "@langchain/langgraph";
import { supabaseAdmin } from "../services/supabase.js";
import { logger } from "../middleware/logger.js";

/**
 * PostgresSaver personalizado para LangGraph
 * Guarda los checkpoints del agente en Supabase
 */
export class PostgresSaver extends BaseCheckpointSaver {
    constructor() {
        super();
    }

    /**
     * Factory method para crear instancia
     */
    static async fromConnString(connString) {
        return new PostgresSaver();
    }

    /**
     * Obtiene el último checkpoint para un thread
     */
    async getTuple(config) {
        try {
            const threadId = config.configurable?.thread_id;

            if (!threadId) {
                return undefined;
            }

            const { data, error } = await supabaseAdmin
                .from('checkpoints')
                .select('*')
                .eq('thread_id', threadId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (error) {
                logger.error('Error getting checkpoint:', error);
                return undefined;
            }

            if (!data) {
                return undefined;
            }

            return {
                config,
                checkpoint: data.checkpoint,
                metadata: data.metadata || {}
            };
        } catch (error) {
            logger.error('Error in getTuple:', error);
            return undefined;
        }
    }

    /**
     * Guarda un checkpoint
     */
    async put(config, checkpoint, metadata) {
        try {
            const threadId = config.configurable?.thread_id;
            const checkpointId = checkpoint.id || Date.now().toString();

            if (!threadId) {
                logger.warn('No thread_id provided for checkpoint');
                return config;
            }

            const { error } = await supabaseAdmin
                .from('checkpoints')
                .insert({
                    thread_id: threadId,
                    checkpoint_id: checkpointId,
                    parent_id: checkpoint.parent_id || null,
                    checkpoint,
                    metadata: metadata || {}
                });

            if (error) {
                // Si es un error de clave duplicada, actualizar en lugar de insertar
                if (error.code === '23505') {
                    const { error: updateError } = await supabaseAdmin
                        .from('checkpoints')
                        .update({
                            checkpoint,
                            metadata: metadata || {}
                        })
                        .eq('thread_id', threadId)
                        .eq('checkpoint_id', checkpointId);

                    if (updateError) {
                        logger.error('Error updating checkpoint:', updateError);
                    }
                } else {
                    logger.error('Error inserting checkpoint:', error);
                }
            }

            return config;
        } catch (error) {
            logger.error('Error in put:', error);
            return config;
        }
    }

    /**
     * Lista checkpoints para un thread
     */
    async *list(config, limit, before) {
        try {
            const threadId = config.configurable?.thread_id;

            if (!threadId) {
                return;
            }

            let query = supabaseAdmin
                .from('checkpoints')
                .select('*')
                .eq('thread_id', threadId)
                .order('created_at', { ascending: false });

            if (limit) {
                query = query.limit(limit);
            }

            if (before) {
                query = query.lt('created_at', before);
            }

            const { data, error } = await query;

            if (error) {
                logger.error('Error listing checkpoints:', error);
                return;
            }

            for (const row of data || []) {
                yield {
                    config,
                    checkpoint: row.checkpoint,
                    metadata: row.metadata || {}
                };
            }
        } catch (error) {
            logger.error('Error in list:', error);
        }
    }
}
