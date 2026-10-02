package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

func main() {
	slot := os.Getenv("FIXTURE_SLOT")
	if slot != "blue" && slot != "green" {
		panic("fixture slot required")
	}
	var requests, streams, sockets, writes atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("/status", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"slot": slot, "requests": requests.Load(),
			"streams": streams.Load(), "sockets": sockets.Load(), "writes": writes.Load()})
	})
	mux.HandleFunc("/fail", func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(slot))
	})
	mux.HandleFunc("/abort", func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	})
	mux.HandleFunc("/sse", func(w http.ResponseWriter, r *http.Request) {
		streams.Add(1)
		defer streams.Add(-1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		for i := 0; i < 60; i++ {
			_, _ = fmt.Fprintf(w, "data: %s-%d\n\n", slot, i)
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(100 * time.Millisecond):
			}
		}
		writes.Add(1)
		go func() {
			time.Sleep(200 * time.Millisecond)
			writes.Add(-1)
		}()
	})
	upgrader := websocket.Upgrader{}
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		sockets.Add(1)
		defer sockets.Add(-1)
		defer conn.Close()
		for {
			kind, message, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if err := conn.WriteMessage(kind, append([]byte(slot+":"), message...)); err != nil {
				return
			}
		}
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write([]byte(slot))
	})
	server := &http.Server{Addr: ":8080", Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if err := server.ListenAndServe(); err != nil {
		panic(err)
	}
}
