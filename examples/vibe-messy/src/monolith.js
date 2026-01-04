// WARNING: This is intentionally bad code for demo purposes!
// It demonstrates violations that Rigour catches.

const express = require('express');
const app = express();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');

// TODO: Add proper database connection
// FIXME: This is a security vulnerability
const SECRET_KEY = 'super-secret-key-hardcoded';

// ============================================
// DATABASE MODELS (should be in separate files)
// ============================================

const userSchema = {
    email: String,
    password: String,
    name: String,
    role: String,
    createdAt: Date,
    updatedAt: Date,
    // TODO: Add email verification
    // TODO: Add password reset token
};

const productSchema = {
    name: String,
    price: Number,
    description: String,
    category: String,
    stock: Number,
    images: Array,
    // FIXME: Add proper validation
};

const orderSchema = {
    userId: String,
    products: Array,
    total: Number,
    status: String,
    shippingAddress: Object,
    paymentMethod: String,
    // TODO: Add order tracking
};

const cartSchema = {
    userId: String,
    items: Array,
    updatedAt: Date,
    // TODO: Add cart expiration
};

// ============================================
// USER AUTHENTICATION (should be auth/index.js)
// ============================================

async function registerUser(email, password, name) {
    // TODO: Validate email format
    // TODO: Check password strength
    // FIXME: Hash password properly

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = {
        email: email,
        password: hashedPassword,
        name: name,
        role: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    // TODO: Save to database
    console.log('User registered:', user);
    return user;
}

async function loginUser(email, password) {
    // TODO: Find user in database
    // FIXME: This is just a stub

    const user = { email: email, id: '123', role: 'user' };

    const token = jwt.sign(
        { userId: user.id, email: user.email, role: user.role },
        SECRET_KEY,
        { expiresIn: '24h' }
    );

    return { user: user, token: token };
}

function verifyToken(token) {
    // TODO: Add token refresh logic
    try {
        return jwt.verify(token, SECRET_KEY);
    } catch (error) {
        return null;
    }
}

async function resetPassword(email) {
    // TODO: Implement password reset
    // TODO: Send email with reset link
    console.log('Password reset requested for:', email);
}

async function changePassword(userId, oldPassword, newPassword) {
    // TODO: Verify old password
    // TODO: Update password in database
    // FIXME: Add password history check
    console.log('Password changed for user:', userId);
}

// ============================================
// PRODUCT MANAGEMENT (should be products/index.js)
// ============================================

async function getAllProducts(page, limit, category) {
    // TODO: Implement pagination
    // TODO: Add caching
    const products = [
        { id: '1', name: 'Product 1', price: 99.99, category: 'electronics' },
        { id: '2', name: 'Product 2', price: 149.99, category: 'electronics' },
        { id: '3', name: 'Product 3', price: 29.99, category: 'clothing' },
    ];

    if (category) {
        return products.filter(p => p.category === category);
    }

    return products;
}

async function getProductById(productId) {
    // TODO: Fetch from database
    // FIXME: Add error handling
    return { id: productId, name: 'Product', price: 99.99 };
}

async function createProduct(productData) {
    // TODO: Validate product data
    // TODO: Upload images
    // TODO: Add to search index
    console.log('Product created:', productData);
    return { id: 'new-id', ...productData };
}

async function updateProduct(productId, updates) {
    // TODO: Validate updates
    // TODO: Update search index
    console.log('Product updated:', productId, updates);
}

async function deleteProduct(productId) {
    // TODO: Soft delete instead of hard delete
    // TODO: Remove from search index
    // FIXME: Check for active orders
    console.log('Product deleted:', productId);
}

async function searchProducts(query) {
    // TODO: Implement full-text search
    // TODO: Add filters
    // TODO: Add sorting
    const products = await getAllProducts();
    return products.filter(p =>
        p.name.toLowerCase().includes(query.toLowerCase())
    );
}

// ============================================
// SHOPPING CART (should be cart/index.js)
// ============================================

async function getCart(userId) {
    // TODO: Fetch from database
    return { userId: userId, items: [], total: 0 };
}

async function addToCart(userId, productId, quantity) {
    // TODO: Check stock availability
    // TODO: Update cart in database
    // FIXME: Handle quantity limits
    console.log('Added to cart:', userId, productId, quantity);
}

async function updateCartItem(userId, productId, quantity) {
    // TODO: Validate quantity
    // TODO: Update database
    console.log('Cart updated:', userId, productId, quantity);
}

async function removeFromCart(userId, productId) {
    // TODO: Remove from database
    console.log('Removed from cart:', userId, productId);
}

async function clearCart(userId) {
    // TODO: Clear from database
    console.log('Cart cleared:', userId);
}

async function calculateCartTotal(userId) {
    // TODO: Apply discounts
    // TODO: Calculate tax
    // TODO: Add shipping cost
    const cart = await getCart(userId);
    return cart.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}

// ============================================
// ORDER MANAGEMENT (should be orders/index.js)
// ============================================

async function createOrder(userId, shippingAddress, paymentMethod) {
    // TODO: Validate address
    // TODO: Process payment
    // TODO: Send confirmation email
    // FIXME: Handle payment failures

    const cart = await getCart(userId);
    const total = await calculateCartTotal(userId);

    const order = {
        id: 'order-' + Date.now(),
        userId: userId,
        products: cart.items,
        total: total,
        status: 'pending',
        shippingAddress: shippingAddress,
        paymentMethod: paymentMethod,
        createdAt: new Date(),
    };

    // TODO: Save to database
    // TODO: Update product stock
    // TODO: Clear cart

    console.log('Order created:', order);
    return order;
}

async function getOrderById(orderId) {
    // TODO: Fetch from database
    // TODO: Add authorization check
    return { id: orderId, status: 'pending' };
}

async function getUserOrders(userId) {
    // TODO: Fetch from database
    // TODO: Add pagination
    return [];
}

async function updateOrderStatus(orderId, status) {
    // TODO: Validate status transition
    // TODO: Send notification
    console.log('Order status updated:', orderId, status);
}

async function cancelOrder(orderId) {
    // TODO: Check if cancellable
    // TODO: Process refund
    // TODO: Restore stock
    console.log('Order cancelled:', orderId);
}

// ============================================
// PAYMENT PROCESSING (should be payments/index.js)
// ============================================

async function processPayment(amount, paymentMethod, cardDetails) {
    // TODO: Integrate with Stripe/PayPal
    // TODO: Handle 3D Secure
    // FIXME: Never log card details!
    console.log('Processing payment:', amount, paymentMethod);

    // Simulated payment
    const success = Math.random() > 0.1;

    if (success) {
        return { success: true, transactionId: 'txn-' + Date.now() };
    } else {
        return { success: false, error: 'Payment declined' };
    }
}

async function refundPayment(transactionId, amount) {
    // TODO: Integrate with payment provider
    console.log('Refund processed:', transactionId, amount);
}

// ============================================
// EMAIL SERVICE (should be services/email.js)
// ============================================

async function sendEmail(to, subject, body) {
    // TODO: Integrate with SendGrid/SES
    // TODO: Add email templates
    console.log('Email sent:', to, subject);
}

async function sendOrderConfirmation(orderId, userEmail) {
    // TODO: Generate order summary
    await sendEmail(userEmail, 'Order Confirmation', 'Your order has been placed.');
}

async function sendShippingNotification(orderId, userEmail, trackingNumber) {
    // TODO: Include tracking link
    await sendEmail(userEmail, 'Order Shipped', 'Your order is on the way.');
}

// ============================================
// ADMIN FUNCTIONS (should be admin/index.js)
// ============================================

async function getAdminDashboard() {
    // TODO: Add proper aggregation
    return {
        totalUsers: 100,
        totalOrders: 50,
        totalRevenue: 5000,
        pendingOrders: 5,
    };
}

async function getAllUsers(page, limit) {
    // TODO: Add pagination
    // TODO: Add search
    return [];
}

async function updateUserRole(userId, newRole) {
    // TODO: Add audit log
    console.log('User role updated:', userId, newRole);
}

async function banUser(userId, reason) {
    // TODO: Add audit log
    // TODO: Send notification
    console.log('User banned:', userId, reason);
}

// ============================================
// ANALYTICS (should be analytics/index.js)
// ============================================

async function trackEvent(eventName, eventData) {
    // TODO: Send to analytics service
    console.log('Event tracked:', eventName, eventData);
}

async function getProductAnalytics(productId) {
    // TODO: Fetch from analytics database
    return { views: 100, purchases: 10, conversionRate: 0.1 };
}

async function getUserAnalytics(userId) {
    // TODO: Fetch user behavior data
    return { totalOrders: 5, totalSpent: 500, lastVisit: new Date() };
}

// ============================================
// EXPRESS ROUTES (should be in routes/ folder)
// ============================================

app.use(express.json());

// Auth routes
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name } = req.body;
        const user = await registerUser(email, password, name);
        res.json({ success: true, user: user });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await loginUser(email, password);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Product routes
app.get('/api/products', async (req, res) => {
    try {
        const products = await getAllProducts(req.query.page, req.query.limit, req.query.category);
        res.json({ success: true, products: products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await getProductById(req.params.id);
        res.json({ success: true, product: product });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/products/search', async (req, res) => {
    try {
        const products = await searchProducts(req.query.q);
        res.json({ success: true, products: products });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Cart routes
app.get('/api/cart', async (req, res) => {
    try {
        // TODO: Get user from token
        const cart = await getCart('user-123');
        res.json({ success: true, cart: cart });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/cart/add', async (req, res) => {
    try {
        const { productId, quantity } = req.body;
        await addToCart('user-123', productId, quantity);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Order routes
app.post('/api/orders', async (req, res) => {
    try {
        const { shippingAddress, paymentMethod } = req.body;
        const order = await createOrder('user-123', shippingAddress, paymentMethod);
        res.json({ success: true, order: order });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders', async (req, res) => {
    try {
        const orders = await getUserOrders('user-123');
        res.json({ success: true, orders: orders });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/orders/:id', async (req, res) => {
    try {
        const order = await getOrderById(req.params.id);
        res.json({ success: true, order: order });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Admin routes
app.get('/api/admin/dashboard', async (req, res) => {
    try {
        // TODO: Add admin authentication
        const dashboard = await getAdminDashboard();
        res.json({ success: true, dashboard: dashboard });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await getAllUsers(req.query.page, req.query.limit);
        res.json({ success: true, users: users });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    // TODO: Add graceful shutdown
    // TODO: Add health check endpoint
    // FIXME: Connect to database before starting
});

// TODO: Add rate limiting
// TODO: Add request logging
// TODO: Add error monitoring
// TODO: Add CORS configuration
// TODO: Add helmet for security headers
// FIXME: This file is way too long and needs to be split up!
