import { tool } from "@langchain/core/tools";
import { z } from "zod";
import axios from "axios";

/**
 * Herramienta para búsqueda en internet
 * Proporciona asesoría adicional sobre productos que ya existen en la base de datos
 */
export const webSearchTool = tool(
    async ({ query }) => {
        try {
            // Verificar si la API key está configurada
            if (!process.env.SERPER_API_KEY) {
                return JSON.stringify({
                    success: false,
                    message: "La búsqueda web no está configurada. Proporciona solo información basada en los productos disponibles en la base de datos."
                });
            }

            // Usar Serper API para búsqueda web
            const response = await axios.post(
                'https://google.serper.dev/search',
                {
                    q: query,
                    num: 3,
                    gl: 'es', // Resultados en español
                    hl: 'es'
                },
                {
                    headers: {
                        'X-API-KEY': process.env.SERPER_API_KEY,
                        'Content-Type': 'application/json'
                    },
                    timeout: 5000 // 5 segundos timeout
                }
            );

            const results = response.data.organic || [];

            if (results.length === 0) {
                return JSON.stringify({
                    success: false,
                    message: "No se encontró información adicional en internet."
                });
            }

            // Formatear resultados
            const formattedResults = results.map(r => ({
                title: r.title,
                snippet: r.snippet,
                link: r.link
            }));

            return JSON.stringify({
                success: true,
                results: formattedResults
            }, null, 2);
        } catch (error) {
            console.error('Error in web search:', error);
            return JSON.stringify({
                success: false,
                error: "Error al buscar información en internet. Proporciona información basada únicamente en los productos disponibles."
            });
        }
    },
    {
        name: "web_search",
        description: "Busca información adicional en internet para proporcionar asesoría al cliente. IMPORTANTE: Usa esto SOLO cuando necesites información complementaria sobre productos que YA EXISTEN en la base de datos. NO uses esta herramienta para buscar productos que no están en nuestra base de datos.",
        schema: z.object({
            query: z.string().describe("La consulta de búsqueda para obtener información adicional de internet")
        })
    }
);
