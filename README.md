# Advantage Auction Platform

This repository is for building the Advantage Auction Platform using a controlled multi-agent workflow.

## Goal
Build a production-ready auction platform where:
- sellers create auctions in a limited seller workspace
- Advantage has full admin control over every auction, lot, and setting
- buyers can bid with live buyer-premium visibility
- debit and credit cards are charged automatically at auction close
- invoices are generated automatically
- pickup dates must begin at least 36 hours after auction end
- seller submissions are locked after final submission
- Advantage must approve and publish auctions before they go live
- the platform remains independent from Brilliant Directories

## Core Roles
- Orchestrator: manages workflow and enforces process
- PM: writes specs, acceptance criteria, and test scenarios
- SWE: implements code and tests
- QA: verifies all acceptance criteria with evidence
- Ops: reviews deployment, background jobs, payment failures, notification failures, and production issues
- Marketing: supports campaign generation, CRM structure, and marketing upsell workflows

## Non-Negotiable Rules
- The same role cannot implement and approve the same task
- No task is considered done until QA passes and PM accepts
- Advantage admin permissions override seller permissions everywhere
- Seller gets one final submission only
- Admin can edit any field, any time, and save repeatedly
- Full address stays hidden until buyer payment is verified
- BD is an external presentation and integration layer, not the source of truth for auction operations