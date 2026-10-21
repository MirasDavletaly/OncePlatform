package mcp

import (
	"bytes"
	"context"
	"encoding/base64"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"onceplatform/internal/apperr"
	"onceplatform/internal/files"
	"onceplatform/internal/search"
)

const (
	readDefaultLimit = 15000
	readMaxLimit     = 50000
	mcpUploadMax     = 10 << 20
)

type listAttachmentsInput struct {
	TicketID string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
}

type readAttachmentInput struct {
	AttachmentID string `json:"attachment_id" jsonschema:"Attachment UUID (from list_attachments or get_ticket)"`
	Offset       int    `json:"offset,omitempty" jsonschema:"Character offset to start from (default 0); use next_offset from the previous call to continue"`
	Limit        int    `json:"limit,omitempty" jsonschema:"Number of characters to return (default 15000, maximum 50000)"`
}

type uploadAttachmentInput struct {
	TicketID      string `json:"ticket_id" jsonschema:"Task UUID or number like T-2026-0001"`
	Filename      string `json:"filename" jsonschema:"File name with extension. Text mode supports .md, .txt, .csv, .html; base64 mode supports pdf, docx, xlsx, pptx, png, jpg, zip and other whitelisted types"`
	Category      string `json:"category,omitempty" jsonschema:"File category (default other): tz = technical specification, analysis, solution, proposal = commercial proposal, other"`
	Content       string `json:"content,omitempty" jsonschema:"Text content for .md/.txt/.csv/.html files (UTF-8)"`
	ContentBase64 string `json:"content_base64,omitempty" jsonschema:"Base64-encoded binary content (up to 10 MB decoded)"`
}

type searchInput struct {
	Query string   `json:"query" jsonschema:"Search text (at least 2 characters); prefix matching works for English, Russian and Kazakh word forms"`
	Kinds []string `json:"kinds,omitempty" jsonschema:"Restrict to these result kinds (default: all)"`
	Limit int      `json:"limit,omitempty" jsonschema:"Results per kind, default 10, maximum 50"`
}

func (s *server) registerOtherTools(srv *sdk.Server) {
	sdk.AddTool(srv, &sdk.Tool{
		Name:        "list_attachments",
		Description: "List files attached to a task, with category, size and text extraction status.",
		InputSchema: inputSchema[listAttachmentsInput](nil),
		Annotations: readOnly("List attachments"),
	}, s.listAttachments)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "read_attachment",
		Description: "Read the text extracted from an attachment (PDF, DOCX, XLSX, PPTX, TXT, MD, CSV) in chunks. Returns total_length and next_offset; call again with offset=next_offset until next_offset is null.",
		InputSchema: inputSchema[readAttachmentInput](nil),
		Annotations: readOnly("Read attachment text"),
	}, s.readAttachment)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "upload_attachment",
		Description: "Create a file in a task either from text (content: md/txt/csv/html) or from base64 (content_base64, up to 10 MB), with a category. The file is marked as uploaded via Claude.",
		InputSchema: inputSchema[uploadAttachmentInput](map[string][]string{"category": files.Categories}),
		Annotations: writeAnn("Upload attachment", false, false),
	}, s.uploadAttachment)

	sdk.AddTool(srv, &sdk.Tool{
		Name:        "search",
		Description: "Global full-text search over tasks, comments and extracted file text. Matches in snippets are wrapped in **double asterisks**.",
		InputSchema: inputSchema[searchInput](map[string][]string{"kinds": search.Kinds}),
		Annotations: readOnly("Search"),
	}, s.search)
}

func (s *server) attachmentList(list []files.Attachment) []map[string]any {
	out := make([]map[string]any, 0, len(list))
	for _, a := range list {
		row := map[string]any{
			"id": a.ID, "name": a.OriginalName, "category": a.Category, "mime": a.Mime, "size_bytes": a.Size,
			"extraction_status": a.ExtractionStatus, "text_length": a.TextLength, "uploaded_by": a.UploadedByName,
			"via": a.Via, "uploaded_at": s.fmtTime(&a.CreatedAt),
		}
		if a.ExtractionError != "" {
			row["extraction_error"] = a.ExtractionError
		}
		out = append(out, row)
	}
	return out
}

func (s *server) listAttachments(ctx context.Context, req *sdk.CallToolRequest, in listAttachmentsInput) (*sdk.CallToolResult, any, error) {
	if _, _, err := caller(req.Extra); err != nil {
		return nil, nil, err
	}
	t, err := s.Tickets.Get(ctx, in.TicketID)
	if err != nil {
		return nil, nil, s.toolError("list_attachments", err)
	}
	list, err := s.Files.List(ctx, files.Target{TicketID: t.ID})
	if err != nil {
		return nil, nil, s.toolError("list_attachments", err)
	}
	return nil, map[string]any{"ticket_number": t.Number, "attachments": s.attachmentList(list)}, nil
}

func (s *server) readAttachment(ctx context.Context, req *sdk.CallToolRequest, in readAttachmentInput) (*sdk.CallToolResult, any, error) {
	if _, _, err := caller(req.Extra); err != nil {
		return nil, nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = readDefaultLimit
	}
	if limit > readMaxLimit {
		limit = readMaxLimit
	}
	chunk, err := s.Files.ReadText(ctx, in.AttachmentID, in.Offset, limit)
	if err != nil {
		return nil, nil, s.toolError("read_attachment", err)
	}
	out := map[string]any{
		"attachment_id": chunk.AttachmentID, "name": chunk.Name, "extraction_status": chunk.ExtractionStatus,
		"offset": chunk.Offset, "total_length": chunk.TotalLength, "next_offset": chunk.NextOffset, "text": chunk.Text,
	}
	switch chunk.ExtractionStatus {
	case "pending":
		out["note"] = "Text extraction is still running; try again in a few seconds."
	case "unsupported":
		out["note"] = "Text cannot be extracted from this file type (images, archives, legacy .doc/.xls/.ppt)."
	case "failed":
		out["note"] = "Text extraction failed: " + chunk.ExtractionError
	case "done":
		if chunk.TotalLength == 0 {
			out["note"] = "The file contains no extractable text (for example, a scanned PDF without a text layer)."
		}
	}
	return nil, out, nil
}

func (s *server) uploadAttachment(ctx context.Context, req *sdk.CallToolRequest, in uploadAttachmentInput) (*sdk.CallToolResult, any, error) {
	actor, _, err := caller(req.Extra)
	if err != nil {
		return nil, nil, err
	}
	t, err := s.Tickets.Get(ctx, in.TicketID)
	if err != nil {
		return nil, nil, s.toolError("upload_attachment", err)
	}
	var body []byte
	switch {
	case in.Content != "" && in.ContentBase64 != "":
		return nil, nil, s.toolError("upload_attachment", apperr.Validation("Provide either content or content_base64, not both"))
	case in.Content != "":
		ext := files.Ext(in.Filename)
		if ext != "md" && ext != "txt" && ext != "csv" && ext != "html" {
			return nil, nil, s.toolError("upload_attachment", apperr.Validation("Text content is supported only for .md, .txt, .csv and .html files; use content_base64 for other types"))
		}
		body = []byte(in.Content)
	case in.ContentBase64 != "":
		raw := strings.Map(func(r rune) rune {
			if r == '\n' || r == '\r' || r == ' ' || r == '\t' {
				return -1
			}
			return r
		}, in.ContentBase64)
		if i := strings.Index(raw, ";base64,"); i >= 0 && strings.HasPrefix(raw, "data:") {
			raw = raw[i+len(";base64,"):]
		}
		if base64.StdEncoding.DecodedLen(len(raw)) > mcpUploadMax+3 {
			return nil, nil, s.toolError("upload_attachment", apperr.TooLarge("File is larger than 10 MB"))
		}
		body, err = base64.StdEncoding.DecodeString(raw)
		if err != nil {
			if body, err = base64.RawStdEncoding.DecodeString(raw); err != nil {
				return nil, nil, s.toolError("upload_attachment", apperr.Validation("content_base64 is not valid base64"))
			}
		}
	default:
		return nil, nil, s.toolError("upload_attachment", apperr.Validation("Provide content or content_base64"))
	}
	if len(body) > mcpUploadMax {
		return nil, nil, s.toolError("upload_attachment", apperr.TooLarge("File is larger than 10 MB"))
	}
	a, err := s.Files.Upload(ctx, actor, files.UploadInput{
		Target: files.Target{TicketID: t.ID}, Name: in.Filename, Category: in.Category,
		Body: bytes.NewReader(body), AllowMCPTypes: true, MaxBytes: mcpUploadMax,
	})
	if err != nil {
		return nil, nil, s.toolError("upload_attachment", err)
	}
	return nil, map[string]any{"uploaded": true, "attachment": s.attachmentList([]files.Attachment{*a})[0],
		"ticket_number": t.Number, "url": s.ticketURL(t.Number)}, nil
}

func (s *server) search(ctx context.Context, req *sdk.CallToolRequest, in searchInput) (*sdk.CallToolResult, any, error) {
	if _, _, err := caller(req.Extra); err != nil {
		return nil, nil, err
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 10
	}
	if limit > 50 {
		limit = 50
	}
	res, err := s.Search.Search(ctx, in.Query, in.Kinds, limit, 0)
	if err != nil {
		return nil, nil, s.toolError("search", err)
	}
	marks := strings.NewReplacer(search.MarkStart, "**", search.MarkStop, "**")
	groups := make([]map[string]any, 0, len(res.Groups))
	for _, g := range res.Groups {
		items := make([]map[string]any, 0, len(g.Items))
		for _, r := range g.Items {
			row := map[string]any{"kind": r.Kind, "id": r.ID, "title": r.Title, "snippet": marks.Replace(r.Snippet)}
			if r.Context != "" {
				row["context"] = r.Context
			}
			if r.TicketNumber != nil {
				row["ticket_number"] = *r.TicketNumber
				row["ticket_id"] = r.TicketID
				row["url"] = s.ticketURL(*r.TicketNumber)
			}
			items = append(items, row)
		}
		groups = append(groups, map[string]any{"kind": g.Kind, "total": g.Total, "items": items})
	}
	return nil, map[string]any{"query": res.Query, "total": res.TotalCount, "groups": groups}, nil
}
