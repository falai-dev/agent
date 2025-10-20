/**
 * Cross-Route Data Sharing Tests
 *
 * Tests the new agent-level data collection architecture where multiple routes
 * can share and contribute to the same agent-level data structure.
 * Covers route completion evaluation, cross-route data collection scenarios,
 * and data sharing between different conversational flows.
 */
import { expect, test, describe } from "bun:test";
import {
  Agent,
  createSession,
} from "../src/index";
import { MockProviderFactory } from "./mock-provider";

// Test data types for comprehensive agent-level data collection
interface CustomerServiceData {
  // Customer identification
  customerId?: string;
  customerName?: string;
  email?: string;
  phone?: string;
  
  // Booking information
  bookingId?: string;
  checkInDate?: string;
  checkOutDate?: string;
  roomType?: string;
  guests?: number;
  
  // Feedback information
  rating?: number;
  comments?: string;
  recommendToFriend?: boolean;
  
  // Support information
  issueType?: 'booking' | 'billing' | 'technical' | 'other';
  issueDescription?: string;
  priority?: 'low' | 'medium' | 'high';
  resolution?: string;
}

interface ECommerceData {
  // Customer info
  customerId?: string;
  customerName?: string;
  email?: string;
  shippingAddress?: string;
  
  // Product selection
  selectedProducts?: Array<{
    id: string;
    name: string;
    price: number;
    quantity: number;
  }>;
  
  // Order processing
  orderId?: string;
  paymentMethod?: 'credit_card' | 'paypal' | 'bank_transfer';
  orderTotal?: number;
  orderStatus?: 'pending' | 'confirmed' | 'shipped' | 'delivered';
  
  // Support/feedback
  supportTicketId?: string;
  feedbackRating?: number;
  feedbackComments?: string;
}

// Test utilities
function createCustomerServiceAgent(): Agent<unknown, CustomerServiceData> {
  return new Agent<unknown, CustomerServiceData>({
    name: "CustomerServiceAgent",
    description: "Comprehensive customer service agent",
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
        phone: { type: "string" },
        bookingId: { type: "string" },
        checkInDate: { type: "string", format: "date" },
        checkOutDate: { type: "string", format: "date" },
        roomType: { type: "string", enum: ["standard", "deluxe", "suite"] },
        guests: { type: "number", minimum: 1, maximum: 10 },
        rating: { type: "number", minimum: 1, maximum: 5 },
        comments: { type: "string" },
        recommendToFriend: { type: "boolean" },
        issueType: { type: "string", enum: ["booking", "billing", "technical", "other"] },
        issueDescription: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high"] },
        resolution: { type: "string" }
      }
    }
  });
}

function createECommerceAgent(): Agent<unknown, ECommerceData> {
  return new Agent<unknown, ECommerceData>({
    name: "ECommerceAgent",
    description: "E-commerce platform agent",
    provider: MockProviderFactory.basic(),
    schema: {
      type: "object",
      properties: {
        customerId: { type: "string" },
        customerName: { type: "string" },
        email: { type: "string", format: "email" },
        shippingAddress: { type: "string" },
        selectedProducts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              price: { type: "number" },
              quantity: { type: "number" },
            },
          },
        },
        orderId: { type: "string" },
        paymentMethod: { type: "string", enum: ["credit_card", "paypal", "bank_transfer"] },
        orderTotal: { type: "number", minimum: 0 },
        orderStatus: { type: "string", enum: ["pending", "confirmed", "shipped", "delivered"] },
        supportTicketId: { type: "string" },
        feedbackRating: { type: "number", minimum: 1, maximum: 5 },
        feedbackComments: { type: "string" },
      }
    }
  });
}

describe("Cross-Route Data Sharing", () => {
  test("should share customer data across booking and feedback routes", async () => {
    const agent = createCustomerServiceAgent();

    // Create booking route
    const bookingRoute = agent.createRoute({
      title: "Hotel Booking",
      requiredFields: ["customerName", "email", "checkInDate", "checkOutDate", "roomType"],
      optionalFields: ["phone", "guests"],
      steps: [
        {
          prompt: "What's your name?",
          collect: ["customerName"],
        },
        {
          prompt: "What's your email?",
          collect: ["email"],
          requires: ["customerName"],
        },
        {
          prompt: "When would you like to check in?",
          collect: ["checkInDate"],
          requires: ["email"],
        },
        {
          prompt: "When would you like to check out?",
          collect: ["checkOutDate"],
          requires: ["checkInDate"],
        },
        {
          prompt: "What room type would you prefer?",
          collect: ["roomType"],
          requires: ["checkOutDate"],
        },
      ],
    });

    // Create feedback route that reuses customer data
    const feedbackRoute = agent.createRoute({
      title: "Feedback Collection",
      requiredFields: ["customerName", "email", "rating"],
      optionalFields: ["comments", "recommendToFriend"],
      steps: [
        {
          prompt: "How would you rate your experience?",
          collect: ["rating"],
        },
        {
          prompt: "Any additional comments?",
          collect: ["comments"],
          requires: ["rating"],
        },
      ],
    });

    // Simulate data collection during booking
    await agent.updateCollectedData({
      customerName: "John Doe",
      email: "john@example.com",
      checkInDate: "2024-03-15",
      checkOutDate: "2024-03-18",
      roomType: "deluxe",
    });

    // Check booking route completion
    const bookingData = agent.getCollectedData();
    expect(bookingRoute.isComplete(bookingData)).toBe(true);
    expect(bookingRoute.getMissingRequiredFields(bookingData)).toEqual([]);

    // Check feedback route partial completion (has customer info, missing rating)
    expect(feedbackRoute.isComplete(bookingData)).toBe(false);
    expect(feedbackRoute.getMissingRequiredFields(bookingData)).toEqual(["rating"]);
    expect(feedbackRoute.getCompletionProgress(bookingData)).toBeCloseTo(0.67, 2); // 2/3 fields

    // Add rating to complete feedback route
    await agent.updateCollectedData({
      rating: 5,
    });

    const updatedData = agent.getCollectedData();
    expect(feedbackRoute.isComplete(updatedData)).toBe(true);
    expect(feedbackRoute.getMissingRequiredFields(updatedData)).toEqual([]);

    // Both routes should now be complete with shared data
    expect(bookingRoute.isComplete(updatedData)).toBe(true);
    expect(feedbackRoute.isComplete(updatedData)).toBe(true);
  });

  test("should handle route completion evaluation across multiple routes", async () => {
    const agent = createCustomerServiceAgent();

    // Create multiple routes with overlapping requirements
    const customerInfoRoute = agent.createRoute({
      title: "Customer Information",
      requiredFields: ["customerName", "email"],
      optionalFields: ["phone"],
    });

    const bookingRoute = agent.createRoute({
      title: "Booking Details",
      requiredFields: ["bookingId", "checkInDate", "checkOutDate"],
      optionalFields: ["roomType", "guests"],
    });

    const supportRoute = agent.createRoute({
      title: "Support Request",
      requiredFields: ["customerName", "email", "issueType", "issueDescription"],
      optionalFields: ["priority"],
    });

    // Initially, no routes should be complete
    const emptyData = agent.getCollectedData();
    expect(customerInfoRoute.isComplete(emptyData)).toBe(false);
    expect(bookingRoute.isComplete(emptyData)).toBe(false);
    expect(supportRoute.isComplete(emptyData)).toBe(false);

    // Add customer information
    await agent.updateCollectedData({
      customerName: "Alice Smith",
      email: "alice@example.com",
    });

    let currentData = agent.getCollectedData();
    expect(customerInfoRoute.isComplete(currentData)).toBe(true); // Customer info complete
    expect(bookingRoute.isComplete(currentData)).toBe(false);
    expect(supportRoute.isComplete(currentData)).toBe(false); // Missing issue info

    // Add booking information
    await agent.updateCollectedData({
      bookingId: "BK123456",
      checkInDate: "2024-04-01",
      checkOutDate: "2024-04-05",
    });

    currentData = agent.getCollectedData();
    expect(customerInfoRoute.isComplete(currentData)).toBe(true);
    expect(bookingRoute.isComplete(currentData)).toBe(true); // Booking complete
    expect(supportRoute.isComplete(currentData)).toBe(false); // Still missing issue info

    // Add support information
    await agent.updateCollectedData({
      issueType: "booking",
      issueDescription: "Need to change check-in date",
    });

    currentData = agent.getCollectedData();
    expect(customerInfoRoute.isComplete(currentData)).toBe(true);
    expect(bookingRoute.isComplete(currentData)).toBe(true);
    expect(supportRoute.isComplete(currentData)).toBe(true); // All routes complete

    // Verify completion progress tracking
    expect(customerInfoRoute.getCompletionProgress(currentData)).toBe(1);
    expect(bookingRoute.getCompletionProgress(currentData)).toBe(1);
    expect(supportRoute.getCompletionProgress(currentData)).toBe(1);
  });

  test("should handle complex e-commerce cross-route scenarios", async () => {
    const agent = createECommerceAgent();

    // Create shopping flow routes
    const customerRoute = agent.createRoute({
      title: "Customer Registration",
      requiredFields: ["customerName", "email"],
      optionalFields: ["shippingAddress"],
    });

    const shoppingRoute = agent.createRoute({
      title: "Product Selection",
      requiredFields: ["selectedProducts"],
      optionalFields: ["customerId"],
    });

    const checkoutRoute = agent.createRoute({
      title: "Order Checkout",
      requiredFields: ["customerName", "email", "selectedProducts", "paymentMethod"],
      optionalFields: ["orderId", "orderTotal"],
    });

    const supportRoute = agent.createRoute({
      title: "Order Support",
      requiredFields: ["customerName", "email", "supportTicketId"],
      optionalFields: ["orderId"],
    });

    // Simulate customer registration
    await agent.updateCollectedData({
      customerName: "Bob Johnson",
      email: "bob@example.com",
      shippingAddress: "123 Main St, Anytown, USA",
    });

    expect(customerRoute.isComplete(agent.getCollectedData())).toBe(true);
    expect(checkoutRoute.isComplete(agent.getCollectedData())).toBe(false); // Missing products and payment

    // Add product selection
    await agent.updateCollectedData({
      selectedProducts: [
        { id: "P001", name: "Widget", price: 19.99, quantity: 2 },
        { id: "P002", name: "Gadget", price: 29.99, quantity: 1 },
      ],
    });

    expect(shoppingRoute.isComplete(agent.getCollectedData())).toBe(true);
    expect(checkoutRoute.isComplete(agent.getCollectedData())).toBe(false); // Missing payment method

    // Add payment method to complete checkout
    await agent.updateCollectedData({
      paymentMethod: "credit_card",
      orderId: "ORD-789",
      orderTotal: 69.97,
    });

    const finalData = agent.getCollectedData();
    expect(customerRoute.isComplete(finalData)).toBe(true);
    expect(shoppingRoute.isComplete(finalData)).toBe(true);
    expect(checkoutRoute.isComplete(finalData)).toBe(true);

    // Support route should be partially complete (has customer info, missing ticket)
    expect(supportRoute.isComplete(finalData)).toBe(false);
    expect(supportRoute.getMissingRequiredFields(finalData)).toEqual(["supportTicketId"]);
    expect(supportRoute.getCompletionProgress(finalData)).toBeCloseTo(0.67, 2); // 2/3 fields

    // Complete support route
    await agent.updateCollectedData({
      supportTicketId: "SUP-456",
    });

    expect(supportRoute.isComplete(agent.getCollectedData())).toBe(true);
  });

  test("should maintain data consistency across route transitions", async () => {
    const agent = createCustomerServiceAgent();

    const route1 = agent.createRoute({
      title: "Initial Contact",
      requiredFields: ["customerName", "email"],
    });

    const route2 = agent.createRoute({
      title: "Issue Resolution",
      requiredFields: ["customerName", "email", "issueType", "issueDescription"],
    });

    // Start with route 1 data
    await agent.updateCollectedData({
      customerName: "Carol White",
      email: "carol@example.com",
    });

    expect(route1.isComplete(agent.getCollectedData())).toBe(true);
    expect(route2.isComplete(agent.getCollectedData())).toBe(false);

    // Simulate session with route transitions
    const session = createSession<CustomerServiceData>();
    session.data = agent.getCollectedData();

    // Add issue data for route 2
    await agent.updateCollectedData({
      issueType: "technical",
      issueDescription: "Website not loading properly",
    });

    // Update session with new data
    session.data = agent.getCollectedData();

    // Both routes should now be complete
    expect(route1.isComplete(session.data!)).toBe(true);
    expect(route2.isComplete(session.data!)).toBe(true);

    // Verify data consistency
    expect(session.data!.customerName).toBe("Carol White");
    expect(session.data!.email).toBe("carol@example.com");
    expect(session.data!.issueType).toBe("technical");
    expect(session.data!.issueDescription).toBe("Website not loading properly");
  });

  test("should handle partial data updates across routes", async () => {
    const agent = createCustomerServiceAgent();

    const infoRoute = agent.createRoute({
      title: "Customer Info",
      requiredFields: ["customerName", "email", "phone"],
    });

    const bookingRoute = agent.createRoute({
      title: "Booking",
      requiredFields: ["bookingId", "checkInDate"],
    });

    // Add partial customer info
    await agent.updateCollectedData({
      customerName: "David Brown",
    });

    expect(infoRoute.getCompletionProgress(agent.getCollectedData())).toBeCloseTo(0.33, 2); // 1/3
    expect(bookingRoute.getCompletionProgress(agent.getCollectedData())).toBe(0); // 0/2

    // Add more customer info
    await agent.updateCollectedData({
      email: "david@example.com",
    });

    expect(infoRoute.getCompletionProgress(agent.getCollectedData())).toBeCloseTo(0.67, 2); // 2/3
    expect(bookingRoute.getCompletionProgress(agent.getCollectedData())).toBe(0); // 0/2

    // Add booking info
    await agent.updateCollectedData({
      bookingId: "BK789",
    });

    expect(infoRoute.getCompletionProgress(agent.getCollectedData())).toBeCloseTo(0.67, 2); // 2/3
    expect(bookingRoute.getCompletionProgress(agent.getCollectedData())).toBe(0.5); // 1/2

    // Complete both routes
    await agent.updateCollectedData({
      phone: "+1-555-0123",
      checkInDate: "2024-05-01",
    });

    const finalData = agent.getCollectedData();
    expect(infoRoute.isComplete(finalData)).toBe(true);
    expect(bookingRoute.isComplete(finalData)).toBe(true);
    expect(infoRoute.getCompletionProgress(finalData)).toBe(1);
    expect(bookingRoute.getCompletionProgress(finalData)).toBe(1);
  });

  test("should validate cross-route field references", () => {
    const agent = createCustomerServiceAgent();

    // Valid cross-route field references should work
    const validRoute1 = agent.createRoute({
      title: "Valid Route 1",
      requiredFields: ["customerName", "email"], // These exist in schema
    });

    const validRoute2 = agent.createRoute({
      title: "Valid Route 2",
      requiredFields: ["issueType", "issueDescription"], // These also exist
    });

    expect(validRoute1.requiredFields).toEqual(["customerName", "email"]);
    expect(validRoute2.requiredFields).toEqual(["issueType", "issueDescription"]);

    // Invalid field references should throw errors
    expect(() => {
      agent.createRoute({
        title: "Invalid Route",
        requiredFields: ["nonExistentField"] as any,
      });
    }).toThrow("Invalid required fields");
  });

  test("should handle route completion with optional fields", async () => {
    const agent = createCustomerServiceAgent();

    const flexibleRoute = agent.createRoute({
      title: "Flexible Route",
      requiredFields: ["customerName", "email"],
      optionalFields: ["phone", "comments", "rating"],
    });

    // Route should be complete with just required fields
    await agent.updateCollectedData({
      customerName: "Eve Green",
      email: "eve@example.com",
    });

    expect(flexibleRoute.isComplete(agent.getCollectedData())).toBe(true);
    expect(flexibleRoute.getCompletionProgress(agent.getCollectedData())).toBe(1);

    // Adding optional fields shouldn't affect completion status
    await agent.updateCollectedData({
      phone: "+1-555-0456",
      comments: "Great service!",
      rating: 5,
    });

    expect(flexibleRoute.isComplete(agent.getCollectedData())).toBe(true);
    expect(flexibleRoute.getCompletionProgress(agent.getCollectedData())).toBe(1);

    // Verify all data is present
    const finalData = agent.getCollectedData();
    expect(finalData.customerName).toBe("Eve Green");
    expect(finalData.email).toBe("eve@example.com");
    expect(finalData.phone).toBe("+1-555-0456");
    expect(finalData.comments).toBe("Great service!");
    expect(finalData.rating).toBe(5);
  });
});

describe("Route Completion Evaluation", () => {
  test("should evaluate completion based on current agent data", async () => {
    const agent = createCustomerServiceAgent();

    const route = agent.createRoute({
      title: "Test Route",
      requiredFields: ["customerName", "email", "issueType"],
    });

    // Test with empty data
    expect(route.isComplete({})).toBe(false);
    expect(route.getMissingRequiredFields({})).toEqual(["customerName", "email", "issueType"]);

    // Test with partial data
    const partialData: Partial<CustomerServiceData> = {
      customerName: "Test User",
    };
    expect(route.isComplete(partialData)).toBe(false);
    expect(route.getMissingRequiredFields(partialData)).toEqual(["email", "issueType"]);

    // Test with complete data
    const completeData: Partial<CustomerServiceData> = {
      customerName: "Test User",
      email: "test@example.com",
      issueType: "technical",
    };
    expect(route.isComplete(completeData)).toBe(true);
    expect(route.getMissingRequiredFields(completeData)).toEqual([]);
  });

  test("should handle empty string and null values correctly", async () => {
    const agent = createCustomerServiceAgent();

    const route = agent.createRoute({
      title: "Validation Route",
      requiredFields: ["customerName", "email"],
    });

    // Empty strings should be considered missing
    const emptyStringData: Partial<CustomerServiceData> = {
      customerName: "",
      email: "test@example.com",
    };
    expect(route.isComplete(emptyStringData)).toBe(false);
    expect(route.getMissingRequiredFields(emptyStringData)).toEqual(["customerName"]);

    // Null values should be considered missing
    const nullData: Partial<CustomerServiceData> = {
      customerName: "Test User",
      email: null as any,
    };
    expect(route.isComplete(nullData)).toBe(false);
    expect(route.getMissingRequiredFields(nullData)).toEqual(["email"]);

    // Undefined values should be considered missing
    const undefinedData: Partial<CustomerServiceData> = {
      customerName: "Test User",
      email: undefined,
    };
    expect(route.isComplete(undefinedData)).toBe(false);
    expect(route.getMissingRequiredFields(undefinedData)).toEqual(["email"]);
  });

  test("should calculate accurate completion progress", async () => {
    const agent = createCustomerServiceAgent();

    const route = agent.createRoute({
      title: "Progress Route",
      requiredFields: ["customerName", "email", "issueType", "issueDescription", "priority"],
    });

    // 0% completion
    expect(route.getCompletionProgress({})).toBe(0);

    // 20% completion (1/5)
    const oneField: Partial<CustomerServiceData> = { customerName: "Test" };
    expect(route.getCompletionProgress(oneField)).toBe(0.2);

    // 40% completion (2/5)
    const twoFields: Partial<CustomerServiceData> = { 
      customerName: "Test", 
      email: "test@example.com" 
    };
    expect(route.getCompletionProgress(twoFields)).toBe(0.4);

    // 60% completion (3/5)
    const threeFields: Partial<CustomerServiceData> = { 
      customerName: "Test", 
      email: "test@example.com",
      issueType: "technical"
    };
    expect(route.getCompletionProgress(threeFields)).toBe(0.6);

    // 80% completion (4/5)
    const fourFields: Partial<CustomerServiceData> = { 
      customerName: "Test", 
      email: "test@example.com",
      issueType: "technical",
      issueDescription: "Problem description"
    };
    expect(route.getCompletionProgress(fourFields)).toBe(0.8);

    // 100% completion (5/5)
    const allFields: Partial<CustomerServiceData> = { 
      customerName: "Test", 
      email: "test@example.com",
      issueType: "technical",
      issueDescription: "Problem description",
      priority: "high"
    };
    expect(route.getCompletionProgress(allFields)).toBe(1);
  });
});