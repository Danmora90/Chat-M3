import { supabaseAdmin } from './supabase.js';

class CartService {
  /**
   * Adds an item to the cart or updates it if it already exists.
   * Fetches the current price from the products table to ensure accuracy.
   * @param {string} chatId 
   * @param {string} productId 
   * @param {number} quantity 
   * @param {string} storeId 
   */
  async addItem(chatId, productId, quantity, storeId) {
    try {
      // 1. Get product details to ensure valid price and existence
      const { data: product, error: productError } = await supabaseAdmin
        .from('products')
        .select('price, name')
        .eq('id', productId)
        .single();

      if (productError || !product) {
        throw new Error(`Product not found: ${productId}`);
      }

      // 2. Check if item exists in cart
      const { data: existingItem, error: fetchError } = await supabaseAdmin
        .from('chat_cart_items')
        .select('id, quantity')
        .eq('chat_id', chatId)
        .eq('product_id', productId)
        .maybeSingle();

      if (fetchError) throw fetchError;

      if (existingItem) {
        // Update existing item
        const newQuantity = existingItem.quantity + quantity;
        const { error: updateError } = await supabaseAdmin
          .from('chat_cart_items')
          .update({
            quantity: newQuantity,
            unit_price: product.price // Update price just in case it changed
          })
          .eq('id', existingItem.id);

        if (updateError) throw updateError;
      } else {
        // Insert new item
        const { error: insertError } = await supabaseAdmin
          .from('chat_cart_items')
          .insert({
            chat_id: chatId,
            product_id: productId,
            store_id: storeId,
            quantity: quantity,
            unit_price: product.price
          });

        if (insertError) throw insertError;
      }

      return { success: true, productName: product.name };
    } catch (error) {
      console.error('Error adding to cart:', error);
      throw error;
    }
  }

  /**
   * Removes an item from the cart.
   * @param {string} chatId 
   * @param {string} productId 
   */
  async removeItem(chatId, productId) {
    try {
      const { error } = await supabaseAdmin
        .from('chat_cart_items')
        .delete()
        .eq('chat_id', chatId)
        .eq('product_id', productId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error removing from cart:', error);
      throw error;
    }
  }

  /**
   * Updates the quantity of an item.
   * @param {string} chatId 
   * @param {string} productId 
   * @param {number} quantity 
   */
  async updateQuantity(chatId, productId, quantity) {
    try {
      if (quantity <= 0) {
        return this.removeItem(chatId, productId);
      }

      const { error } = await supabaseAdmin
        .from('chat_cart_items')
        .update({ quantity: quantity })
        .eq('chat_id', chatId)
        .eq('product_id', productId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error updating cart quantity:', error);
      throw error;
    }
  }

  /**
   * Clears the entire cart for a chat.
   * @param {string} chatId 
   */
  async clearCart(chatId) {
    try {
      const { error } = await supabaseAdmin
        .from('chat_cart_items')
        .delete()
        .eq('chat_id', chatId);

      if (error) throw error;
      return { success: true };
    } catch (error) {
      console.error('Error clearing cart:', error);
      throw error;
    }
  }

  /**
   * Retrieves the current cart with product details.
   * @param {string} chatId 
   */
  async getCart(chatId) {
    try {
      const { data, error } = await supabaseAdmin
        .from('chat_cart_items')
        .select(`
          id,
          quantity,
          unit_price,
          product_id,
          products (
            name,
            description
          )
        `)
        .eq('chat_id', chatId);

      if (error) throw error;

      // Calculate totals
      const items = data.map(item => ({
        productId: item.product_id,
        name: item.products ? item.products.name : 'Unknown Product',
        quantity: item.quantity,
        unitPrice: item.unit_price,
        subtotal: item.quantity * item.unit_price
      }));

      const total = items.reduce((sum, item) => sum + item.subtotal, 0);

      return { items, total };
    } catch (error) {
      console.error('Error fetching cart:', error);
      throw error;
    }
  }
}

export const cartService = new CartService();
