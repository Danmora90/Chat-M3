import { automationService } from '../services/automationService.js';
import { logger } from '../middleware/logger.js';

let intervalId = null;
let isProcessing = false;

/**
 * Inicia el worker en segundo plano para procesar la cola de automatizaciones
 * Se ejecuta cada 60 segundos
 */
export function startAutomationWorker(intervalSeconds = 60) {
    if (intervalId) {
        logger.warn('Automation worker is already running');
        return;
    }

    logger.info(`Starting automation worker (interval: ${intervalSeconds}s)...`);

    const runWorkerCycle = async () => {
        if (isProcessing) {
            return;
        }

        isProcessing = true;
        try {
            // 1. Evaluar disparadores de inactividad de chats (ej. 5 min sin respuesta)
            await automationService.checkInactivityTriggers();

            // 2. Procesar tareas pendientes cuya hora de ejecución ya venció
            await automationService.processQueue();
        } catch (error) {
            logger.error('Error during automation worker cycle:', { error: error.message || error });
        } finally {
            isProcessing = false;
        }
    };

    // Ejecutar ciclo inicial
    runWorkerCycle();

    // Programar repetición periódica
    intervalId = setInterval(runWorkerCycle, intervalSeconds * 1000);
}

/**
 * Detiene el worker
 */
export function stopAutomationWorker() {
    if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        logger.info('Automation worker stopped');
    }
}
