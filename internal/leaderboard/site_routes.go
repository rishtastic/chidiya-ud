package leaderboard

import "net/http"

func (s *server) registerSiteRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET "+apiPrefix+"/items", s.listPublishedItems)
	mux.HandleFunc("POST "+apiPrefix+"/auth/register", s.authRegister)
	mux.HandleFunc("POST "+apiPrefix+"/auth/login", s.authLogin)
	mux.HandleFunc("GET "+apiPrefix+"/auth/me", s.authMe)
	mux.HandleFunc("POST "+apiPrefix+"/auth/logout", s.authLogout)
	mux.HandleFunc("POST "+apiPrefix+"/auth/reset", s.authReset)
	mux.HandleFunc("POST "+apiPrefix+"/guest/end", s.endGuest)
	mux.HandleFunc("GET "+apiPrefix+"/admin/items", s.adminListItems)
	mux.HandleFunc("POST "+apiPrefix+"/admin/items", s.adminCreateItem)
	mux.HandleFunc("PUT "+apiPrefix+"/admin/items/{id}/draft", s.adminSaveItemDraft)
	mux.HandleFunc("POST "+apiPrefix+"/admin/items/{id}/publish", s.adminPublishItem)
	mux.HandleFunc("GET "+apiPrefix+"/admin/scores", s.adminListScores)
	mux.HandleFunc("POST "+apiPrefix+"/admin/scores/{id}/claim", s.adminClaimScore)
	mux.HandleFunc("POST "+apiPrefix+"/admin/scores/{id}/unclaim", s.adminUnclaimScore)
	mux.HandleFunc("GET "+apiPrefix+"/admin/users", s.adminListUsers)
	mux.HandleFunc("GET "+apiPrefix+"/admin/users/lookup", s.adminLookupUser)
	mux.HandleFunc("POST "+apiPrefix+"/admin/users/{id}/reset", s.adminResetUser)
	mux.HandleFunc("POST "+apiPrefix+"/admin/users/{id}/roles", s.adminSetRoles)
}
