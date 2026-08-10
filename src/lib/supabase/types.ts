export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          full_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          full_name?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          full_name?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          full_name: string;
          company_name: string | null;
          phone: string | null;
          email: string | null;
          shipping_address: string | null;
          quickbooks_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          full_name: string;
          company_name?: string | null;
          phone?: string | null;
          email?: string | null;
          shipping_address?: string | null;
          quickbooks_customer_id?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          full_name?: string;
          company_name?: string | null;
          phone?: string | null;
          email?: string | null;
          shipping_address?: string | null;
          quickbooks_customer_id?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      quickbooks_invoices: {
        Row: {
          id: string;
          quickbooks_invoice_id: string;
          quickbooks_customer_id: string | null;
          invoice_number: string;
          invoice_date: string | null;
          invoice_total: number | null;
          payment_status: string | null;
          billing_address: string | null;
          shipping_address: string | null;
          raw_payload: Json | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          quickbooks_invoice_id: string;
          quickbooks_customer_id?: string | null;
          invoice_number: string;
          invoice_date?: string | null;
          invoice_total?: number | null;
          payment_status?: string | null;
          billing_address?: string | null;
          shipping_address?: string | null;
          raw_payload?: Json | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          quickbooks_customer_id?: string | null;
          invoice_number?: string;
          invoice_date?: string | null;
          invoice_total?: number | null;
          payment_status?: string | null;
          billing_address?: string | null;
          shipping_address?: string | null;
          raw_payload?: Json | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      quickbooks_connections: {
        Row: {
          id: string;
          realm_id: string;
          environment: "sandbox" | "production";
          status: "connected" | "disconnected" | "error";
          encrypted_access_token: string | null;
          encrypted_refresh_token: string | null;
          access_token_expires_at: string | null;
          refresh_token_expires_at: string | null;
          last_sync_at: string | null;
          last_sync_status: string | null;
          last_sync_error: string | null;
          connected_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          realm_id: string;
          environment: "sandbox" | "production";
          status?: "connected" | "disconnected" | "error";
          encrypted_access_token?: string | null;
          encrypted_refresh_token?: string | null;
          access_token_expires_at?: string | null;
          refresh_token_expires_at?: string | null;
          last_sync_at?: string | null;
          last_sync_status?: string | null;
          last_sync_error?: string | null;
          connected_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          realm_id?: string;
          environment?: "sandbox" | "production";
          status?: "connected" | "disconnected" | "error";
          encrypted_access_token?: string | null;
          encrypted_refresh_token?: string | null;
          access_token_expires_at?: string | null;
          refresh_token_expires_at?: string | null;
          last_sync_at?: string | null;
          last_sync_status?: string | null;
          last_sync_error?: string | null;
          connected_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      customer_service_cases: {
        Row: {
          id: string;
          case_number: string;
          customer_id: string;
          case_type: "General" | "Warranty" | "Freight Damage";
          quickbooks_invoice_id: string | null;
          quickbooks_invoice_number: string | null;
          quickbooks_invoice_link: string | null;
          product_model: string | null;
          serial_number: string | null;
          date_of_purchase: string | null;
          issue_reported_at: string;
          issue_description: string;
          assigned_employee_id: string | null;
          priority: "Low" | "Medium" | "High";
          status:
            | "New"
            | "In Progress"
            | "Waiting for Customer"
            | "Under Review"
            | "Parts Needed"
            | "Parts Ordered"
            | "Parts Shipped"
            | "Service Scheduled"
            | "Completed"
            | "Resolved"
            | "Closed";
          internal_notes: string | null;
          customer_facing_notes: string | null;
          final_resolution: string | null;
          closed_at: string | null;
          created_by: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          case_number?: string;
          customer_id: string;
          case_type?: "General" | "Warranty" | "Freight Damage";
          quickbooks_invoice_id?: string | null;
          quickbooks_invoice_number?: string | null;
          quickbooks_invoice_link?: string | null;
          product_model?: string | null;
          serial_number?: string | null;
          date_of_purchase?: string | null;
          issue_reported_at?: string;
          issue_description: string;
          assigned_employee_id?: string | null;
          priority?: "Low" | "Medium" | "High";
          status?:
            | "New"
            | "In Progress"
            | "Waiting for Customer"
            | "Under Review"
            | "Parts Needed"
            | "Parts Ordered"
            | "Parts Shipped"
            | "Service Scheduled"
            | "Completed"
            | "Resolved"
            | "Closed";
          internal_notes?: string | null;
          customer_facing_notes?: string | null;
          final_resolution?: string | null;
          closed_at?: string | null;
          created_by: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          customer_id?: string;
          case_type?: "General" | "Warranty" | "Freight Damage";
          quickbooks_invoice_id?: string | null;
          quickbooks_invoice_number?: string | null;
          quickbooks_invoice_link?: string | null;
          product_model?: string | null;
          serial_number?: string | null;
          date_of_purchase?: string | null;
          issue_reported_at?: string;
          issue_description?: string;
          assigned_employee_id?: string | null;
          priority?: "Low" | "Medium" | "High";
          status?:
            | "New"
            | "In Progress"
            | "Waiting for Customer"
            | "Under Review"
            | "Parts Needed"
            | "Parts Ordered"
            | "Parts Shipped"
            | "Service Scheduled"
            | "Completed"
            | "Resolved"
            | "Closed";
          internal_notes?: string | null;
          customer_facing_notes?: string | null;
          final_resolution?: string | null;
          closed_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          sku: string;
          canonical_name: string;
          description: string | null;
          status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          sku: string;
          canonical_name: string;
          description?: string | null;
          status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          sku?: string;
          canonical_name?: string;
          description?: string | null;
          status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      product_aliases: {
        Row: {
          id: string;
          product_id: string;
          alias: string;
          source_type: string;
          source_ref: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          product_id: string;
          alias: string;
          source_type?: string;
          source_ref?: string | null;
          created_at?: string;
        };
        Update: {
          product_id?: string;
          alias?: string;
          source_type?: string;
          source_ref?: string | null;
        };
        Relationships: [];
      };
      qbo_invoices: {
        Row: {
          id: string;
          customer_id: string | null;
          qbo_invoice_id: string;
          invoice_number: string | null;
          invoice_date: string | null;
          payment_status: string;
          total_amount: number | null;
          raw_payload: Json | null;
          sync_status: string;
          imported_at: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id?: string | null;
          qbo_invoice_id: string;
          invoice_number?: string | null;
          invoice_date?: string | null;
          payment_status?: string;
          total_amount?: number | null;
          raw_payload?: Json | null;
          sync_status?: string;
          imported_at?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          customer_id?: string | null;
          qbo_invoice_id?: string;
          invoice_number?: string | null;
          invoice_date?: string | null;
          payment_status?: string;
          total_amount?: number | null;
          raw_payload?: Json | null;
          sync_status?: string;
          imported_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      qbo_invoice_lines: {
        Row: {
          id: string;
          qbo_invoice_id: string;
          qbo_line_id: string;
          qbo_item_id: string | null;
          qbo_sku: string | null;
          source_description: string | null;
          product_id: string | null;
          ordered_qty: number;
          unit_price: number | null;
          line_total: number | null;
          mapping_status: string;
          approval_status: string;
          warehouse_status: string;
          allocation_status: string;
          fulfillment_status: string;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          qbo_invoice_id: string;
          qbo_line_id: string;
          qbo_item_id?: string | null;
          qbo_sku?: string | null;
          source_description?: string | null;
          product_id?: string | null;
          ordered_qty?: number;
          unit_price?: number | null;
          line_total?: number | null;
          mapping_status?: string;
          approval_status?: string;
          warehouse_status?: string;
          allocation_status?: string;
          fulfillment_status?: string;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          qbo_invoice_id?: string;
          qbo_line_id?: string;
          qbo_item_id?: string | null;
          qbo_sku?: string | null;
          source_description?: string | null;
          product_id?: string | null;
          ordered_qty?: number;
          unit_price?: number | null;
          line_total?: number | null;
          mapping_status?: string;
          approval_status?: string;
          warehouse_status?: string;
          allocation_status?: string;
          fulfillment_status?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      shipping_orders: {
        Row: {
          id: string;
          customer_id: string | null;
          source_invoice_id: string | null;
          order_number: string | null;
          source_type: string;
          review_status: string;
          promised_ship_date: string | null;
          shipping_method: string | null;
          notes: string | null;
          tracking_number: string | null;
          carrier: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          customer_id?: string | null;
          source_invoice_id?: string | null;
          order_number?: string | null;
          source_type?: string;
          review_status?: string;
          promised_ship_date?: string | null;
          shipping_method?: string | null;
          notes?: string | null;
          tracking_number?: string | null;
          carrier?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          customer_id?: string | null;
          source_invoice_id?: string | null;
          order_number?: string | null;
          source_type?: string;
          review_status?: string;
          promised_ship_date?: string | null;
          shipping_method?: string | null;
          notes?: string | null;
          tracking_number?: string | null;
          carrier?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      shipping_order_lines: {
        Row: {
          id: string;
          shipping_order_id: string;
          qbo_invoice_line_id: string | null;
          product_id: string;
          ordered_qty: number;
          approved_qty: number;
          fulfilled_qty: number;
          cancelled_qty: number;
          approval_status: string;
          warehouse_status: string;
          allocation_status: string;
          fulfillment_status: string;
          priority: string;
          queue_position_start: number | null;
          queue_position_count: number | null;
          approved_at: string | null;
          source_event_key: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          shipping_order_id: string;
          qbo_invoice_line_id?: string | null;
          product_id: string;
          ordered_qty?: number;
          approved_qty?: number;
          fulfilled_qty?: number;
          cancelled_qty?: number;
          approval_status?: string;
          warehouse_status?: string;
          allocation_status?: string;
          fulfillment_status?: string;
          priority?: string;
          queue_position_start?: number | null;
          queue_position_count?: number | null;
          approved_at?: string | null;
          source_event_key?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          shipping_order_id?: string;
          qbo_invoice_line_id?: string | null;
          product_id?: string;
          ordered_qty?: number;
          approved_qty?: number;
          fulfilled_qty?: number;
          cancelled_qty?: number;
          approval_status?: string;
          warehouse_status?: string;
          allocation_status?: string;
          fulfillment_status?: string;
          priority?: string;
          queue_position_start?: number | null;
          queue_position_count?: number | null;
          approved_at?: string | null;
          source_event_key?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      fulfillments: {
        Row: {
          id: string;
          shipping_order_line_id: string;
          fulfilled_qty: number;
          fulfilled_at: string;
          shipment_number: string | null;
          carrier: string | null;
          tracking_number: string | null;
          reason: string | null;
          actor_id: string | null;
          source_event_key: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          shipping_order_line_id: string;
          fulfilled_qty?: number;
          fulfilled_at?: string;
          shipment_number?: string | null;
          carrier?: string | null;
          tracking_number?: string | null;
          reason?: string | null;
          actor_id?: string | null;
          source_event_key?: string | null;
          created_at?: string;
        };
        Update: {
          shipping_order_line_id?: string;
          fulfilled_qty?: number;
          fulfilled_at?: string;
          shipment_number?: string | null;
          carrier?: string | null;
          tracking_number?: string | null;
          reason?: string | null;
          actor_id?: string | null;
          source_event_key?: string | null;
        };
        Relationships: [];
      };
      inventory_transactions: {
        Row: {
          id: string;
          product_id: string;
          bucket: string;
          delta: number;
          before_qty: number;
          after_qty: number;
          reason: string;
          source_type: string;
          source_id: string | null;
          source_event_key: string | null;
          container_id: string | null;
          shipping_order_line_id: string | null;
          actor_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          product_id: string;
          bucket: string;
          delta: number;
          before_qty?: number;
          after_qty?: number;
          reason: string;
          source_type: string;
          source_id?: string | null;
          source_event_key?: string | null;
          container_id?: string | null;
          shipping_order_line_id?: string | null;
          actor_id?: string | null;
          created_at?: string;
        };
        Update: {
          product_id?: string;
          bucket?: string;
          delta?: number;
          before_qty?: number;
          after_qty?: number;
          reason?: string;
          source_type?: string;
          source_id?: string | null;
          source_event_key?: string | null;
          container_id?: string | null;
          shipping_order_line_id?: string | null;
          actor_id?: string | null;
        };
        Relationships: [];
      };
      inventory_allocations: {
        Row: {
          id: string;
          shipping_order_line_id: string;
          product_id: string;
          container_id: string | null;
          quantity: number;
          allocation_status: string;
          source_type: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          shipping_order_line_id: string;
          product_id: string;
          container_id?: string | null;
          quantity?: number;
          allocation_status?: string;
          source_type?: string;
          created_at?: string;
        };
        Update: {
          shipping_order_line_id?: string;
          product_id?: string;
          container_id?: string | null;
          quantity?: number;
          allocation_status?: string;
          source_type?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: string;
          entity_type: string;
          entity_id: string | null;
          action: string;
          actor_id: string | null;
          details: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          entity_type: string;
          entity_id?: string | null;
          action: string;
          actor_id?: string | null;
          details?: Json | null;
          created_at?: string;
        };
        Update: {
          entity_type?: string;
          entity_id?: string | null;
          action?: string;
          actor_id?: string | null;
          details?: Json | null;
        };
        Relationships: [];
      };
      containers: {
        Row: {
          id: string;
          container_number: string;
          supplier: string | null;
          order_date: string | null;
          entered_date: string | null;
          deposit_amount: number | null;
          deposit_date: string | null;
          final_payment_amount: number | null;
          final_payment_date: string | null;
          remaining_balance: number | null;
          payment_status: string;
          production_status: string;
          lifecycle_status: string;
          tracking_number: string | null;
          eta_estimated_date: string | null;
          eta_confirmed_date: string | null;
          port_date: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          container_number: string;
          supplier?: string | null;
          order_date?: string | null;
          entered_date?: string | null;
          deposit_amount?: number | null;
          deposit_date?: string | null;
          final_payment_amount?: number | null;
          final_payment_date?: string | null;
          remaining_balance?: number | null;
          payment_status?: string;
          production_status?: string;
          lifecycle_status?: string;
          tracking_number?: string | null;
          eta_estimated_date?: string | null;
          eta_confirmed_date?: string | null;
          port_date?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          container_number?: string;
          supplier?: string | null;
          order_date?: string | null;
          entered_date?: string | null;
          deposit_amount?: number | null;
          deposit_date?: string | null;
          final_payment_amount?: number | null;
          final_payment_date?: string | null;
          remaining_balance?: number | null;
          payment_status?: string;
          production_status?: string;
          lifecycle_status?: string;
          tracking_number?: string | null;
          eta_estimated_date?: string | null;
          eta_confirmed_date?: string | null;
          port_date?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      container_lines: {
        Row: {
          id: string;
          container_id: string;
          product_id: string;
          ordered_qty: number;
          received_qty: number;
          on_order_qty: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          container_id: string;
          product_id: string;
          ordered_qty?: number;
          received_qty?: number;
          on_order_qty?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          container_id?: string;
          product_id?: string;
          ordered_qty?: number;
          received_qty?: number;
          on_order_qty?: number;
          updated_at?: string;
        };
        Relationships: [];
      };
      case_notes: {
        Row: {
          id: string;
          case_id: string;
          note_type: "internal" | "customer";
          content: string;
          created_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          case_id: string;
          note_type?: "internal" | "customer";
          content: string;
          created_by: string;
          created_at?: string;
        };
        Update: {
          note_type?: "internal" | "customer";
          content?: string;
        };
        Relationships: [];
      };
      case_attachments: {
        Row: {
          id: string;
          case_id: string;
          file_path: string;
          file_name: string;
          file_size: number | null;
          mime_type: string | null;
          uploaded_by: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          case_id: string;
          file_path: string;
          file_name: string;
          file_size?: number | null;
          mime_type?: string | null;
          uploaded_by: string;
          created_at?: string;
        };
        Update: {
          file_name?: string;
        };
        Relationships: [];
      };
      case_activity: {
        Row: {
          id: string;
          case_id: string;
          actor_id: string | null;
          activity_type: string;
          summary: string;
          details: Json | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          case_id: string;
          actor_id?: string | null;
          activity_type: string;
          summary: string;
          details?: Json | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      installation_jobs: {
        Row: {
          id: string;
          invoice_number: string;
          quickbooks_invoice_id: string | null;
          quickbooks_customer_id: string | null;
          customer_name: string;
          company_name: string | null;
          phone: string | null;
          email: string | null;
          shipping_address: string | null;
          summary: string | null;
          status: "New" | "In Progress" | "Completed" | "Blocked";
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          invoice_number: string;
          quickbooks_invoice_id?: string | null;
          quickbooks_customer_id?: string | null;
          customer_name: string;
          company_name?: string | null;
          phone?: string | null;
          email?: string | null;
          shipping_address?: string | null;
          summary?: string | null;
          status?: "New" | "In Progress" | "Completed" | "Blocked";
          created_by?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          invoice_number?: string;
          quickbooks_invoice_id?: string | null;
          quickbooks_customer_id?: string | null;
          customer_name?: string;
          company_name?: string | null;
          phone?: string | null;
          email?: string | null;
          shipping_address?: string | null;
          summary?: string | null;
          status?: "New" | "In Progress" | "Completed" | "Blocked";
          created_by?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      installation_notes: {
        Row: {
          id: string;
          installation_job_id: string;
          content: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          installation_job_id: string;
          content: string;
          created_by?: string | null;
          created_at?: string;
        };
        Update: {
          content?: string;
          created_by?: string | null;
        };
        Relationships: [];
      };
      installation_photos: {
        Row: {
          id: string;
          installation_job_id: string;
          file_path: string;
          file_name: string;
          file_size: number | null;
          mime_type: string | null;
          uploaded_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          installation_job_id: string;
          file_path: string;
          file_name: string;
          file_size?: number | null;
          mime_type?: string | null;
          uploaded_by?: string | null;
          created_at?: string;
        };
        Update: {
          file_name?: string;
          file_path?: string;
          file_size?: number | null;
          mime_type?: string | null;
          uploaded_by?: string | null;
        };
        Relationships: [];
      };
      replacement_parts: {
        Row: {
          id: string;
          case_id: string;
          part_name: string;
          sku: string | null;
          quantity: number;
          product_model: string | null;
          supplier: string | null;
          cost: number | null;
          order_date: string | null;
          ordered_by: string | null;
          shipping_status: string | null;
          carrier: string | null;
          tracking_number: string | null;
          ship_date: string | null;
          delivery_date: string | null;
          notes: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          case_id: string;
          part_name: string;
          sku?: string | null;
          quantity?: number;
          product_model?: string | null;
          supplier?: string | null;
          cost?: number | null;
          order_date?: string | null;
          ordered_by?: string | null;
          shipping_status?: string | null;
          carrier?: string | null;
          tracking_number?: string | null;
          ship_date?: string | null;
          delivery_date?: string | null;
          notes?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          part_name?: string;
          sku?: string | null;
          quantity?: number;
          product_model?: string | null;
          supplier?: string | null;
          cost?: number | null;
          order_date?: string | null;
          ordered_by?: string | null;
          shipping_status?: string | null;
          carrier?: string | null;
          tracking_number?: string | null;
          ship_date?: string | null;
          delivery_date?: string | null;
          notes?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      access_users: {
        Row: {
          id: string;
          full_name: string;
          access_code: string;
          is_active: boolean;
          last_login_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          full_name: string;
          access_code: string;
          is_active?: boolean;
          last_login_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          full_name?: string;
          access_code?: string;
          is_active?: boolean;
          last_login_at?: string | null;
          updated_at?: string;
        };
        Relationships: [];
      };
      access_login_events: {
        Row: {
          id: string;
          access_user_id: string | null;
          full_name_snapshot: string | null;
          success: boolean;
          login_at: string;
        };
        Insert: {
          id?: string;
          access_user_id?: string | null;
          full_name_snapshot?: string | null;
          success: boolean;
          login_at?: string;
        };
        Update: never;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      note_type: "internal" | "customer";
    };
    CompositeTypes: Record<string, never>;
  };
};
