import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { supabaseAdmin } from "../services/supabase.js";

/**
 * Herramienta para búsqueda de materiales y servicios en Supabase
 * Utiliza búsqueda full-text en español para encontrar recursos relevantes
 */
export const materialSearchTool = tool(
    async ({ query }) => {
        try {
            // Asumiendo que ahora los materiales o servicios se guardan en una tabla genérica o en la misma tabla "products" pero adaptada para remodelación
            const { data, error } = await supabaseAdmin
                .from('products') // Puedes cambiar esto a 'materials' si la DB cambió
                .select('*')
                .textSearch('search_vector', query, {
                    type: 'websearch',
                    config: 'spanish'
                })
                .eq('is_active', true)
                .limit(5);

            if (error) {
                console.error('Database error:', error);
                throw error;
            }

            if (!data || data.length === 0) {
                return JSON.stringify({
                    found: false,
                    message: "No se encontraron materiales o servicios que coincidan con la búsqueda."
                });
            }

            const formattedResults = data.map(item => ({
                id: item.id,
                name: item.name,
                description: item.description,
                category: item.category, // e.g. 'Pisos', 'Pinturas', 'Mano de Obra'
                price: item.price,
                stock: item.stock,
                specifications: item.specifications
            }));

            return JSON.stringify({
                found: true,
                count: data.length,
                materials: formattedResults
            }, null, 2);
        } catch (error) {
            console.error('Error searching materials:', error);
            return JSON.stringify({
                found: false,
                error: "Error al buscar el catálogo. Por favor, intenta de nuevo."
            });
        }
    },
    {
        name: "material_and_service_search",
        description: "Busca en el catálogo de materiales (pisos, pinturas, grifería) o servicios usando lenguaje natural. Úsala cuando necesites saber qué materiales ofrecemos o sus precios antes de sugerirlos al cliente.",
        schema: z.object({
            query: z.string().describe("Consulta de búsqueda sobre materiales de construcción o servicios.")
        })
    }
);
